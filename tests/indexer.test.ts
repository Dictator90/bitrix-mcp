import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex, readIndex } from "../src/indexer/indexer.js";
import { DatabaseSync } from "node:sqlite";
import { sqlitePath } from "../src/config/paths.js";
import { addPathDocSource, indexDocResourcesToSqlite, listDocResources } from "../src/resources/docs.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../src/liveapi/search.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

test("buildIndex indexes project PHP symbols", async () => {
  const root = fixtureRoot;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-project-"));
  const outFile = path.join(dataDir, "project-index.json");
  const manifest = await buildIndex({ root, kind: "project", outFile });
  assert.ok(manifest.files.length >= 2);
  await assert.rejects(fs.access(outFile));
  const sqliteManifest = await readIndex(outFile, "project");
  assert.equal(sqliteManifest?.root, root);
  const results = await searchLiveApi(sqlitePath(dataDir), { query: "demo_helper" });
  assert.equal(results?.[0]?.item.name, "demo_helper");

  const jsFile = manifest.files.find((file) => file.relativePath === "local/modules/vendor.module/install/js/admin/widget.ts");
  assert.equal(jsFile?.language, "typescript");
  assert.ok(jsFile?.symbols.some((symbol) => symbol.type === "class" && symbol.name === "VendorWidget" && symbol.module === "vendor.module" && symbol.language === "typescript"));
});

test("SQLite FTS searches classes, methods, events, and docs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-fts-"));
  const outFile = path.join(dataDir, "project-index.json");
  await buildIndex({ root: fixtureRoot, kind: "project", outFile });

  const classResults = await searchLiveApi(sqlitePath(dataDir), { query: "DemoComponent", type: "class", limit: 5 });
  assert.equal(classResults?.[0]?.item.name, "DemoComponent");

  const methodResults = await searchLiveApi(sqlitePath(dataDir), { query: "execute", type: "method", limit: 5 });
  assert.equal(methodResults?.[0]?.item.name, "executeComponent");

  const jsResults = await searchLiveApi(sqlitePath(dataDir), { query: "VendorWidget", type: "class", limit: 5 });
  assert.equal(jsResults?.[0]?.item.name, "VendorWidget");
  assert.equal(jsResults?.[0]?.item.module, "vendor.module");
  assert.equal(jsResults?.[0]?.item.language, "typescript");

  const objectMethodResults = await searchLiveApi(sqlitePath(dataDir), { query: "helpers.prepare", type: "object_method", module: "vendor.module", limit: 5 });
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

test("template index uses template-specific patterns", async () => {
  const root = fixtureRoot;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-template-"));
  const outFile = path.join(dataDir, "template-index.json");
  const manifest = await buildIndex({ root, kind: "template", outFile });
  assert.ok(manifest.files.every((file) => file.relativePath.includes("templates")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "template_helper")));
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
