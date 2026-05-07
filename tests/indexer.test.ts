import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildIndex, readIndex } from "../src/indexer/indexer.js";
import { DatabaseSync } from "node:sqlite";
import { sqlitePath } from "../src/config/paths.js";
import { addPathDocSource, indexDocResourcesToSqlite, listDocResources } from "../src/resources/docs.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../src/liveapi/search.js";

const fixtureRoot = path.resolve("tests/fixtures/project");
const execFileAsync = promisify(execFile);

async function createGitDocsRepository(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-docs-git-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Tests"], { cwd: repo });
  await fs.mkdir(path.join(repo, "pages", "framework"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "pages", "framework", "routing.md"),
    "# Роутинг\n\nМиграция с устаревшего urlrewrite.php использует bitrix/routing_index.php и PublicPageController.\n",
    "utf8"
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "Add routing docs"], { cwd: repo });
  return repo;
}

test("buildIndex indexes project PHP symbols", async () => {
  const root = fixtureRoot;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-project-"));
  const outFile = path.join(dataDir, "project-index.json");
  const manifest = await buildIndex({ root, kind: "project", outFile });
  assert.ok(manifest.files.length >= 1);
  await assert.rejects(fs.access(outFile));
  const sqliteManifest = await readIndex(outFile, "project");
  assert.equal(sqliteManifest?.root, root);
  const results = await searchLiveApi(sqlitePath(dataDir), { query: "demo_helper" });
  assert.equal(results?.[0]?.item.name, "demo_helper");
});

test("SQLite FTS searches classes, methods, events, and docs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-fts-"));
  const outFile = path.join(dataDir, "project-index.json");
  await buildIndex({ root: fixtureRoot, kind: "project", outFile });
  await buildIndex({ root: fixtureRoot, kind: "install", outFile: path.join(dataDir, "install-index.json") });

  const classResults = await searchLiveApi(sqlitePath(dataDir), { query: "DemoComponent", type: "class", limit: 5 });
  assert.equal(classResults?.[0]?.item.name, "DemoComponent");

  const methodResults = await searchLiveApi(sqlitePath(dataDir), { query: "execute", type: "method", limit: 5 });
  assert.equal(methodResults?.[0]?.item.name, "executeComponent");

  const jsResults = await searchLiveApi(sqlitePath(dataDir), { query: "VendorWidget", type: "class", kind: "install", limit: 5 });
  assert.equal(jsResults?.[0]?.item.name, "VendorWidget");
  assert.equal(jsResults?.[0]?.item.module, "vendor.module");
  assert.equal(jsResults?.[0]?.item.language, "typescript");

  const objectMethodResults = await searchLiveApi(sqlitePath(dataDir), { query: "helpers.prepare", type: "object_method", module: "vendor.module", kind: "install", limit: 5 });
  assert.equal(objectMethodResults?.[0]?.item.name, "helpers.prepare");

  const eventResults = await searchLiveApi(sqlitePath(dataDir), { query: "OnBefore", type: "event", module: "main", limit: 5 });
  assert.equal(eventResults?.[0]?.item.name, "main:OnBeforeProlog");

  const eventTableResults = await searchSqliteEvents(sqlitePath(dataDir), { query: "Demo", module: "main", limit: 5 });
  assert.equal(eventTableResults?.[0]?.item.eventName, "OnBeforeProlog");
  assert.equal(eventTableResults?.[0]?.item.handlerClass, "Demo");
  assert.equal(eventTableResults?.[0]?.item.handlerMethod, "handler");

  await addPathDocSource(dataDir, path.join(fixtureRoot, "docs"));
  await indexDocResourcesToSqlite(dataDir);
  const docResults = await searchSqliteDocs(sqlitePath(dataDir), { query: "managed cache", limit: 5 });
  assert.match(docResults?.[0]?.item.text ?? "", /managed cache/);
});

test("documentation markdown chunks preserve section heading metadata", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-markdown-docs-"));
  await addPathDocSource(dataDir, path.join(fixtureRoot, "docs"));

  await indexDocResourcesToSqlite(dataDir, [], { force: true });

  const results = await searchSqliteDocs(sqlitePath(dataDir), { query: "unique-heading-preservation-token", limit: 5 });
  assert.equal(results?.[0]?.item.headingPath, "Framework Guide > Caching > Managed Cache Details");
  assert.equal(results?.[0]?.item.sectionAnchor, "managed-cache-details");
  assert.equal(results?.[0]?.item.relativePath, path.join("framework", "markdown-headings.md"));

  const db = new DatabaseSync(sqlitePath(dataDir));
  try {
    const row = db.prepare(`
      SELECT heading_path, section_anchor, source_uri, relative_path
      FROM doc_chunks
      WHERE text LIKE '%unique-heading-preservation-token%'
      LIMIT 1
    `).get() as { heading_path: string; section_anchor: string; source_uri: string; relative_path: string } | undefined;

    assert.equal(row?.heading_path, "Framework Guide > Caching > Managed Cache Details");
    assert.equal(row?.section_anchor, "managed-cache-details");
    assert.match(row?.source_uri ?? "", /^bitrix-docs:\/\/path-\d+\/framework\/markdown-headings\.md$/);
    assert.equal(row?.relative_path, path.join("framework", "markdown-headings.md"));
  } finally {
    db.close();
  }
});

test("documentation index supports multiple registered local paths", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-docs-"));
  const docsOne = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-docs-one-"));
  const docsTwo = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-docs-two-"));

  await fs.writeFile(path.join(docsOne, "cache.md"), "# Cache docs\nmanaged cache details\n", "utf8");
  await fs.writeFile(path.join(docsTwo, "events.txt"), "# Event docs\nOnBeforeProlog event details\n", "utf8");

  await addPathDocSource(dataDir, docsOne, "custom-one");
  await addPathDocSource(dataDir, docsTwo, "custom-two");
  const chunks = await indexDocResourcesToSqlite(dataDir);

  assert.equal(chunks, 2);
  const resources = await listDocResources(dataDir);
  assert.equal(resources.length, 2);
  assert.ok(resources.some((resource) => resource.uri.startsWith("bitrix-docs://path-") && resource.path === path.join(docsOne, "cache.md")));
  assert.ok(resources.some((resource) => resource.uri.startsWith("bitrix-docs://path-") && resource.path === path.join(docsTwo, "events.txt")));
});


test("documentation index skips unchanged docs and updates changed/deleted docs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-docs-"));
  const docsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-root-"));
  const unchangedPath = path.join(docsRoot, "unchanged.md");
  const changedPath = path.join(docsRoot, "changed.md");
  const deletedPath = path.join(docsRoot, "deleted.md");

  await fs.writeFile(unchangedPath, "# Unchanged\nstable managed cache text\n", "utf8");
  await fs.writeFile(changedPath, "# Changed\nold token\n", "utf8");
  await fs.writeFile(deletedPath, "# Deleted\nremoved token\n", "utf8");

  await addPathDocSource(dataDir, docsRoot, "incremental-docs");
  assert.equal(await indexDocResourcesToSqlite(dataDir), 3);

  const dbFile = sqlitePath(dataDir);
  const before = new DatabaseSync(dbFile);
  let unchangedIndexedAt: string;
  let changedIndexedAt: string;
  try {
    const rows = before.prepare("SELECT path, size, mtime_ms, indexed_at FROM docs ORDER BY path").all() as Array<{ path: string; size: number; mtime_ms: number; indexed_at: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.size > 0));
    assert.ok(rows.every((row) => row.mtime_ms > 0));
    unchangedIndexedAt = rows.find((row) => row.path === unchangedPath)?.indexed_at ?? "";
    changedIndexedAt = rows.find((row) => row.path === changedPath)?.indexed_at ?? "";
    assert.ok(unchangedIndexedAt);
    assert.ok(changedIndexedAt);
  } finally {
    before.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(changedPath, "# Changed\nnew searchable token appears\n", "utf8");
  await fs.rm(deletedPath);

  assert.equal(await indexDocResourcesToSqlite(dataDir), 2);

  const after = new DatabaseSync(dbFile);
  try {
    const rows = after.prepare("SELECT path, indexed_at FROM docs ORDER BY path").all() as Array<{ path: string; indexed_at: string }>;
    assert.deepEqual(rows.map((row) => row.path), [changedPath, unchangedPath]);
    assert.equal(rows.find((row) => row.path === unchangedPath)?.indexed_at, unchangedIndexedAt);
    assert.notEqual(rows.find((row) => row.path === changedPath)?.indexed_at, changedIndexedAt);

    const deletedChunks = after.prepare(`
      SELECT COUNT(*) AS count
      FROM doc_chunks c
      JOIN docs d ON d.id = c.doc_id
      WHERE d.path = ?
    `).get(deletedPath) as { count: number };
    assert.equal(deletedChunks.count, 0);
  } finally {
    after.close();
  }

  const results = await searchSqliteDocs(dbFile, { query: "new searchable token", limit: 5 });
  assert.equal(results?.[0]?.item.path, changedPath);

  assert.equal(await indexDocResourcesToSqlite(dataDir), 2);
});

test("documentation index force option reindexes unchanged docs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-force-docs-"));
  const docsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-force-root-"));
  const docPath = path.join(docsRoot, "force.md");

  await fs.writeFile(docPath, "# Force\nmanaged cache force text\n", "utf8");
  await addPathDocSource(dataDir, docsRoot, "force-docs");
  assert.equal(await indexDocResourcesToSqlite(dataDir), 1);
  assert.equal(await indexDocResourcesToSqlite(dataDir), 1);
  assert.equal(await indexDocResourcesToSqlite(dataDir, [], { force: true }), 1);
});


test("documentation index can bootstrap and search a Git docs source", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-docs-git-data-"));
  const docsRepo = await createGitDocsRepository();

  const chunks = await indexDocResourcesToSqlite(dataDir, [], { includeOfficialDocs: true, officialDocsUrl: docsRepo });
  const results = await searchSqliteDocs(sqlitePath(dataDir), { query: "Миграция urlrewrite.php PublicPageController", limit: 5 });
  const resources = await listDocResources(dataDir);

  assert.equal(chunks, 1);
  assert.match(results?.[0]?.item.text ?? "", /Миграция с устаревшего urlrewrite\.php/);
  assert.ok(resources.some((resource) => resource.path.endsWith(path.join("pages", "framework", "routing.md"))));
});

test("documentation index scans multiple runtime docs paths", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-runtime-docs-"));
  const docsOne = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-runtime-one-"));
  const docsTwo = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-runtime-two-"));

  await fs.writeFile(path.join(docsOne, "cache.md"), "# Runtime Cache\nmanaged cache runtime details\n", "utf8");
  await fs.writeFile(path.join(docsTwo, "events.txt"), "# Runtime Events\nOnBeforeProlog runtime details\n", "utf8");

  const chunks = await indexDocResourcesToSqlite(dataDir, [docsOne, docsTwo]);

  assert.equal(chunks, 2);
  const resources = await listDocResources(dataDir);
  assert.equal(resources.length, 2);
  assert.ok(resources.some((resource) => resource.path === path.join(docsOne, "cache.md")));
  assert.ok(resources.some((resource) => resource.path === path.join(docsTwo, "events.txt")));

  const db = new DatabaseSync(sqlitePath(dataDir));
  try {
    const docs = db.prepare(`
      SELECT d.path, d.source_id, d.source_name, s.name
      FROM docs d
      JOIN doc_sources s ON s.id = d.source_id
      ORDER BY d.path
    `).all() as Array<{ path: string; source_id: number; source_name: string; name: string }>;

    assert.equal(docs.length, 2);
    assert.ok(docs.every((doc) => doc.source_id > 0));
    assert.deepEqual(docs.map((doc) => doc.source_name), docs.map((doc) => doc.name));
  } finally {
    db.close();
  }
});


test(".bitrixmcpignore excludes PHP and JS files from SQLite index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-ignore-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-ignore-data-"));
  const outFile = path.join(dataDir, "project-index.json");

  await fs.mkdir(path.join(root, "private"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "index.php"), "<?php function visible_helper() {}\n", "utf8");
  await fs.writeFile(path.join(root, "private", "secret.php"), "<?php function secret_helper() {}\n", "utf8");
  await fs.writeFile(path.join(root, "assets", "ignored.js"), "export const ignored = true;\n", "utf8");
  await fs.writeFile(path.join(root, ".bitrixmcpignore"), "private/*.php\nassets/ignored.js\n", "utf8");

  const manifest = await buildIndex({ root, kind: "project", outFile });
  assert.deepEqual(
    manifest.files.map((file) => file.relativePath),
    ["index.php"]
  );

  const sqliteManifest = await readIndex(outFile, "project");
  assert.deepEqual(
    sqliteManifest?.files.map((file) => file.relativePath),
    ["index.php"]
  );
});

test("bitrix and install indexes include downloaded core ignored by project .gitignore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-gitignored-core-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-gitignored-data-"));

  await fs.mkdir(path.join(root, "bitrix/modules/main/install/js/admin"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "/bitrix/\n", "utf8");
  await fs.writeFile(path.join(root, "index.php"), "<?php function visible_project(): void {}\n", "utf8");
  await fs.writeFile(path.join(root, "bitrix/modules/main/include.php"), "<?php class GitignoredCoreClass {}\n", "utf8");
  await fs.writeFile(path.join(root, "bitrix/modules/main/install/js/admin/panel.ts"), "export class GitignoredInstallPanel {}\n", "utf8");

  const projectManifest = await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json") });
  assert.deepEqual(projectManifest.files.map((file) => file.relativePath), ["index.php"]);

  const bitrixManifest = await buildIndex({ root, kind: "bitrix", outFile: path.join(dataDir, "bitrix-index.json"), patterns: ["bitrix/modules/**/*.php"] });
  assert.deepEqual(bitrixManifest.files.map((file) => file.relativePath), ["bitrix/modules/main/include.php"]);

  const installManifest = await buildIndex({ root, kind: "install", outFile: path.join(dataDir, "install-index.json"), patterns: ["bitrix/modules/*/install/**/*.{js,ts}"] });
  assert.deepEqual(installManifest.files.map((file) => file.relativePath), ["bitrix/modules/main/install/js/admin/panel.ts"]);
});


test("kind-specific indexes do not duplicate fixture files", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-kind-dedup-"));

  const projectManifest = await buildIndex({ root: fixtureRoot, kind: "project", outFile: path.join(dataDir, "project-index.json") });
  const templateManifest = await buildIndex({ root: fixtureRoot, kind: "template", outFile: path.join(dataDir, "template-index.json") });
  const installManifest = await buildIndex({ root: fixtureRoot, kind: "install", outFile: path.join(dataDir, "install-index.json") });

  const indexedByRelativePath = new Map<string, string[]>();
  for (const manifest of [projectManifest, templateManifest, installManifest]) {
    for (const file of manifest.files) {
      indexedByRelativePath.set(file.relativePath, [...(indexedByRelativePath.get(file.relativePath) ?? []), manifest.kind]);
    }
  }

  assert.deepEqual(projectManifest.files.map((file) => file.relativePath), ["docs/framework/markdown-headings.md", "docs/framework/search.md", "index.php"]);
  assert.deepEqual(indexedByRelativePath.get("index.php"), ["project"]);
  assert.deepEqual(indexedByRelativePath.get("local/modules/vendor.module/install/js/admin/widget.ts"), ["install"]);
  assert.deepEqual(indexedByRelativePath.get("local/templates/main/components/bitrix/news.list/.default/template.php"), ["template"]);
  assert.ok([...indexedByRelativePath.values()].every((kinds) => kinds.length === 1));

  const projectInstallResults = await searchLiveApi(sqlitePath(dataDir), { query: "VendorWidget", type: "class", kind: "project", limit: 5 });
  const installResults = await searchLiveApi(sqlitePath(dataDir), { query: "VendorWidget", type: "class", kind: "install", limit: 5 });
  assert.equal(projectInstallResults?.length ?? 0, 0);
  assert.equal(installResults?.[0]?.item.name, "VendorWidget");
});

test("template index uses Bitrix template-specific patterns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-template-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-template-"));
  const outFile = path.join(dataDir, "template-index.json");

  await fs.mkdir(path.join(root, "local/templates/site"), { recursive: true });
  await fs.mkdir(path.join(root, "bitrix/templates/legacy"), { recursive: true });
  await fs.mkdir(path.join(root, "templates/not-bitrix"), { recursive: true });
  await fs.writeFile(path.join(root, "local/templates/site/template.php"), "<?php function local_template_helper(): void {}\n", "utf8");
  await fs.writeFile(path.join(root, "bitrix/templates/legacy/template.php"), "<?php function bitrix_template_helper(): void {}\n", "utf8");
  await fs.writeFile(path.join(root, "templates/not-bitrix/template.php"), "<?php function invalid_template_helper(): void {}\n", "utf8");

  const manifest = await buildIndex({ root, kind: "template", outFile });
  const relativePaths = manifest.files.map((file) => file.relativePath);

  assert.deepEqual(relativePaths, ["bitrix/templates/legacy/template.php", "local/templates/site/template.php"]);
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "local_template_helper")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "bitrix_template_helper")));
  assert.ok(manifest.files.every((file) => file.symbols.every((symbol) => symbol.name !== "invalid_template_helper")));
});

test("incremental build skips unchanged files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-skip-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-skip-data-"));
  const outFile = path.join(dataDir, "project-index.json");
  const filePath = path.join(root, "index.php");

  await fs.writeFile(filePath, "<?php function unchanged_helper(): void {}\n", "utf8");
  await buildIndex({ root, kind: "project", outFile });

  const dbFile = sqlitePath(dataDir);
  const firstDb = new DatabaseSync(dbFile);
  let firstIndexedAt: string;
  try {
    firstIndexedAt = (firstDb.prepare("SELECT indexed_at FROM files WHERE relative_path = ?").get("index.php") as { indexed_at: string }).indexed_at;
  } finally {
    firstDb.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 10));
  await buildIndex({ root, kind: "project", outFile });

  const secondDb = new DatabaseSync(dbFile);
  try {
    const row = secondDb.prepare("SELECT indexed_at FROM files WHERE relative_path = ?").get("index.php") as { indexed_at: string };
    assert.equal(row.indexed_at, firstIndexedAt);
  } finally {
    secondDb.close();
  }

  const results = await searchLiveApi(dbFile, { query: "unchanged_helper", type: "function" });
  assert.equal(results?.[0]?.item.name, "unchanged_helper");
});

test("incremental build reparses changed files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-change-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-change-data-"));
  const outFile = path.join(dataDir, "project-index.json");
  const filePath = path.join(root, "index.php");

  await fs.writeFile(filePath, "<?php function old_incremental_helper(): void {}\n", "utf8");
  await buildIndex({ root, kind: "project", outFile });

  await fs.writeFile(filePath, "<?php function new_incremental_helper(): void {}\n", "utf8");
  const future = new Date(Date.now() + 2000);
  await fs.utimes(filePath, future, future);
  await buildIndex({ root, kind: "project", outFile });

  const dbFile = sqlitePath(dataDir);
  const oldResults = await searchLiveApi(dbFile, { query: "old_incremental_helper", type: "function" });
  const newResults = await searchLiveApi(dbFile, { query: "new_incremental_helper", type: "function" });
  assert.equal(oldResults?.length ?? 0, 0);
  assert.equal(newResults?.[0]?.item.name, "new_incremental_helper");
});

test("incremental build removes deleted files from SQLite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-delete-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-incremental-delete-data-"));
  const outFile = path.join(dataDir, "project-index.json");
  const keepPath = path.join(root, "keep.php");
  const deletePath = path.join(root, "delete.php");

  await fs.writeFile(keepPath, "<?php function kept_incremental_helper(): void {}\n", "utf8");
  await fs.writeFile(deletePath, "<?php function deleted_incremental_helper(): void {}\n", "utf8");
  await buildIndex({ root, kind: "project", outFile });

  await fs.unlink(deletePath);
  await buildIndex({ root, kind: "project", outFile });

  const sqliteManifest = await readIndex(outFile, "project");
  assert.deepEqual(sqliteManifest?.files.map((file) => file.relativePath), ["keep.php"]);

  const deletedResults = await searchLiveApi(sqlitePath(dataDir), { query: "deleted_incremental_helper", type: "function" });
  assert.equal(deletedResults?.length ?? 0, 0);
});


test("readIndex falls back to legacy JSON files", async () => {
  const legacyFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-legacy-")), "project-index.json");
  const legacyManifest = {
    version: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    root: fixtureRoot,
    kind: "project" as const,
    files: []
  };

  await fs.writeFile(legacyFile, JSON.stringify(legacyManifest), "utf8");

  assert.deepEqual(await readIndex(legacyFile, "project"), legacyManifest);
});
