import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqlitePath } from "../src/config/paths.js";
import { openDatabase } from "../src/indexer/database.js";
import { buildIndex } from "../src/indexer/indexer.js";
import { resolveTemplateIndexOptions } from "../src/indexer/template.js";
import { ensureSqliteStore, readIndexFromSqlite, searchAgents, searchCallSites } from "../src/indexer/sqliteStore.js";
import { searchLiveApi } from "../src/liveapi/search.js";
import type { RuntimePaths } from "../src/config/paths.js";

async function makeProject(files: Record<string, string>): Promise<{ root: string; dataDir: string; paths: RuntimePaths }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-scope-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-scope-data-"));
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents, "utf8");
  }
  const paths: RuntimePaths = {
    workspaceRoot: root,
    dataDir,
    docsDir: path.join(root, "docs"),
    docsPaths: [path.join(root, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };
  return { root, dataDir, paths };
}

test("indexing one template directory keeps the other templates in the index", async () => {
  const { root, dataDir, paths } = await makeProject({
    "local/templates/main/header.php": "<?php\nfunction main_template_helper() {}\n",
    "local/templates/landing/header.php": "<?php\nfunction landing_template_helper() {}\n"
  });
  try {
    await buildIndex(resolveTemplateIndexOptions(paths));
    await fs.writeFile(path.join(root, "local/templates/main/footer.php"), "<?php\nfunction main_footer_helper() {}\n", "utf8");
    await buildIndex(resolveTemplateIndexOptions(paths, "local/templates/main"));

    const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");
    const relativePaths = manifest?.files.map((file) => file.relativePath).sort();
    assert.deepEqual(relativePaths, ["local/templates/landing/header.php", "local/templates/main/footer.php", "local/templates/main/header.php"]);
    const results = await searchLiveApi(sqlitePath(dataDir), { query: "landing_template_helper", kind: "template" });
    assert.equal(results?.[0]?.item.name, "landing_template_helper");

    await fs.rm(path.join(root, "local/templates/main/footer.php"));
    await buildIndex(resolveTemplateIndexOptions(paths, "local/templates/main"));
    const pruned = await readIndexFromSqlite(sqlitePath(dataDir), "template");
    assert.deepEqual(pruned?.files.map((file) => file.relativePath).sort(), ["local/templates/landing/header.php", "local/templates/main/header.php"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("files indexed by an older parser version are re-parsed even when unchanged", async () => {
  const { root, dataDir } = await makeProject({ "a.php": "<?php\nfunction alpha() {}\n", "b.php": "<?php\nfunction beta() {}\n" });
  try {
    const options = { root, kind: "project" as const, dbFile: sqlitePath(dataDir) };
    await buildIndex(options);
    const unchanged = await buildIndex(options);
    assert.ok(unchanged.files.every((file) => file.symbols.length === 0), "second run should skip unchanged files");

    const db = openDatabase(sqlitePath(dataDir));
    db.prepare("UPDATE files SET parser_version = 0 WHERE relative_path = 'a.php'").run();
    db.close();

    const rerun = await buildIndex(options);
    const byPath = new Map(rerun.files.map((file) => [file.relativePath, file]));
    assert.ok(byPath.get("a.php")?.symbols.some((symbol) => symbol.name === "alpha"), "stale parser version must be re-parsed");
    assert.equal(byPath.get("b.php")?.symbols.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("call sites are stored apart from symbols and found by callee name", async () => {
  const { root, dataDir } = await makeProject({
    "usage.php": "<?php\nCIBlockElement::GetList([], ['ACTIVE' => 'Y', 'IBLOCK_ID' => 5, 'SECTION_ID' => 10, 'INCLUDE_SUBSECTIONS' => 'Y']);\n$logger->write('x');\nfunction defined_here() {}\n"
  });
  try {
    await buildIndex({ root, kind: "project", dbFile: sqlitePath(dataDir) });
    const symbols = await searchLiveApi(sqlitePath(dataDir), { query: "GetList" });
    assert.equal(symbols?.some((result) => result.item.type === "static_call"), false);

    const exact = await searchCallSites(sqlitePath(dataDir), { query: "ciblockelement::getlist" });
    assert.equal(exact[0]?.item.name, "CIBlockElement::GetList");
    assert.equal(exact[0]?.item.relativeFile, "usage.php");
    assert.ok((exact[0]?.item.signature?.length ?? 0) <= 161);
    const bare = await searchCallSites(sqlitePath(dataDir), { query: "write" });
    assert.equal(bare[0]?.item.name, "$logger->write");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("reads and writes wait for a concurrent writer instead of failing with 'database is locked'", async () => {
  const { root, dataDir } = await makeProject({ "a.php": "<?php\nfunction alpha() {}\n" });
  try {
    const dbFile = sqlitePath(dataDir);
    await buildIndex({ root, kind: "project", dbFile });
    await ensureSqliteStore(dbFile);

    // Another process holds the write lock for ~1.5 s, like a running index.
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.exec("BEGIN IMMEDIATE; INSERT INTO index_meta (key, value, updated_at) VALUES ('lock-test', '1', 'now') ON CONFLICT(key) DO UPDATE SET value = '2';");
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      db.exec("COMMIT;");
      db.close();
    `], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));

    const agents = await searchAgents(dbFile, { query: "anything" });
    assert.ok(Array.isArray(agents));
    const started = Date.now();
    await fs.writeFile(path.join(root, "b.php"), "<?php\nfunction beta() {}\n", "utf8");
    await buildIndex({ root, kind: "project", dbFile });
    assert.ok(Date.now() - started < 10_000);
    await exited;
    const results = await searchLiveApi(dbFile, { query: "beta" });
    assert.equal(results?.[0]?.item.name, "beta");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
