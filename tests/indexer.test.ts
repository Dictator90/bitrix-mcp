import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { buildIndex, readIndex } from "../src/indexer/indexer.js";
import { DatabaseSync } from "node:sqlite";
import { sqlitePath } from "../src/config/paths.js";
import { clearBitrixRelationsByFile, clearBitrixRelationsByKind, ensureSqliteStore, getIndexStatus, readIndexWarnings, getOrmEntityMap, getComponentContext, searchAgents, searchBitrixRelations, searchComponents, searchHlblockUsages, searchIblockUsages, searchMailEvents, searchModuleUsages, searchOptionUsages, searchOrmEntities, searchOrmUsages, writeBitrixRelations } from "../src/indexer/sqliteStore.js";
import { addPathDocSource, indexDocResourcesToSqlite, listDocResources, prepareEmbeddingDocumentsFromSqlite } from "../src/resources/docs.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../src/liveapi/search.js";
import { formatDoctor, runDoctor } from "../src/indexer/actions.js";
import { possibleComponentTemplateRelativePaths } from "../src/indexer/template.js";

const fixtureRoot = path.resolve("tests/fixtures/project");
const execFileAsync = promisify(execFile);



test("indexes Bitrix option reads and writes with relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-options-"));
  const optionFile = path.join(root, "options.php");
  await fs.mkdir(path.dirname(optionFile), { recursive: true });
  await fs.writeFile(optionFile, String.raw`<?php
use Bitrix\Main\Config\Option;

function vendor_option_reader(): void
{
    Option::get('vendor.module', 'some_option');
    Option::set('vendor.module', 'set_option', 'Y');
    \Bitrix\Main\Config\Option::get('vendor.module', 'fq_option');
    COption::GetOptionString('vendor.module', 'legacy_string');
    COption::SetOptionString('vendor.module', 'legacy_set', 'N');
    COption::GetOptionInt('vendor.module', 'legacy_int');
    COption::SetOptionInt('vendor.module', 'legacy_set_int', 1);
    Option::get('vendor.module', $dynamicName);
}
`);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-options-db-"));
  const dbFile = sqlitePath(dataDir);
  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project.json") });

  const all = await searchOptionUsages(dbFile, { module: "vendor.module", limit: 20 });
  assert.equal(all?.length, 7);
  assert.ok(all?.some((usage) => usage.name === "some_option" && usage.operation === "get" && usage.api === "Option::get"));
  assert.ok(all?.some((usage) => usage.name === "set_option" && usage.operation === "set" && usage.api === "Option::set"));
  assert.ok(all?.some((usage) => usage.name === "fq_option" && usage.api === "Bitrix\\Main\\Config\\Option::get"));
  assert.ok(all?.some((usage) => usage.name === "legacy_string" && usage.api === "COption::GetOptionString"));
  assert.ok(all?.some((usage) => usage.name === "legacy_set" && usage.api === "COption::SetOptionString"));
  assert.ok(all?.some((usage) => usage.name === "legacy_int" && usage.api === "COption::GetOptionInt"));
  assert.ok(all?.some((usage) => usage.name === "legacy_set_int" && usage.api === "COption::SetOptionInt"));

  const dynamic = await searchOptionUsages(dbFile, { query: "dynamicName", limit: 20 });
  assert.equal(dynamic?.length, 0);

  const setOnly = await searchOptionUsages(dbFile, { operation: "set", limit: 20 });
  assert.equal(setOnly?.length, 3);

  const relations = await searchBitrixRelations(dbFile, { targetType: "option", targetName: "vendor.module:some_option", limit: 10 });
  assert.ok(relations?.some((relation) => relation.sourceType === "file" && relation.relationType === "uses_option"));
  assert.ok(relations?.some((relation) => relation.sourceType === "module" && relation.relationType === "defines_option"));
  assert.ok(relations?.some((relation) => relation.sourceType === "function" && relation.sourceName.endsWith("vendor_option_reader") && relation.relationType === "uses_option"));
});

test("Bitrix relations SQLite storage creates table and indexes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-relations-schema-"));
  const dbFile = sqlitePath(dataDir);

  await ensureSqliteStore(dbFile);

  const db = new DatabaseSync(dbFile);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bitrix_relations'").get();
    assert.ok(table);
    const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bitrix_relations'").all() as Array<{ name: string }>).map((row) => row.name));
    assert.ok(indexes.has("idx_bitrix_relations_relation_type"));
    assert.ok(indexes.has("idx_bitrix_relations_source"));
    assert.ok(indexes.has("idx_bitrix_relations_target"));
    assert.ok(indexes.has("idx_bitrix_relations_file"));
    assert.ok(indexes.has("idx_bitrix_relations_kind"));
    assert.ok(indexes.has("idx_bitrix_relations_module"));
  } finally {
    db.close();
  }
});

test("Bitrix relations SQLite storage inserts and searches relations", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-relations-search-"));
  const dbFile = sqlitePath(dataDir);
  const fileA = path.join(fixtureRoot, "local", "modules", "vendor.module", "lib", "agent.php");
  const fileB = path.join(fixtureRoot, "local", "modules", "vendor.module", "lib", "event.php");

  await writeBitrixRelations(dbFile, [
    {
      sourceType: "agent",
      sourceName: "Vendor\\Module\\Agent::run",
      targetType: "class",
      targetName: "Vendor\\Module\\Service",
      relationType: "calls",
      file: fileA,
      line: 12,
      module: "vendor.module",
      kind: "agent",
      signature: "Agent::run();",
      metadata: { interval: 60 }
    },
    {
      sourceType: "event",
      sourceName: "main:OnBeforeProlog",
      targetType: "method",
      targetName: "Vendor\\Module\\Handler::onBeforeProlog",
      relationType: "handles",
      file: fileB,
      line: 24,
      module: "main",
      kind: "event"
    },
    {
      sourceType: "component",
      sourceName: "bitrix:news.list",
      targetType: "module",
      targetName: "iblock",
      relationType: "requires",
      file: fileB,
      line: 42,
      module: "iblock",
      kind: "component"
    }
  ]);

  const allRelations = await searchBitrixRelations(dbFile, { limit: 10 });
  assert.equal(allRelations?.length, 3);

  const sourceResults = await searchBitrixRelations(dbFile, { sourceType: "agent", sourceName: "Vendor\\Module\\Agent::run" });
  assert.equal(sourceResults?.length, 1);
  assert.equal(sourceResults?.[0]?.targetName, "Vendor\\Module\\Service");
  assert.deepEqual(sourceResults?.[0]?.metadata, { interval: 60 });

  const targetResults = await searchBitrixRelations(dbFile, { targetType: "method", targetName: "Vendor\\Module\\Handler::onBeforeProlog" });
  assert.equal(targetResults?.length, 1);
  assert.equal(targetResults?.[0]?.sourceName, "main:OnBeforeProlog");

  const relationTypeResults = await searchBitrixRelations(dbFile, { relationType: "requires" });
  assert.equal(relationTypeResults?.length, 1);
  assert.equal(relationTypeResults?.[0]?.sourceName, "bitrix:news.list");
});

test("Bitrix relations SQLite storage clears by kind and file", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-relations-clear-"));
  const dbFile = sqlitePath(dataDir);
  const fileA = path.join(fixtureRoot, "a.php");
  const fileB = path.join(fixtureRoot, "b.php");

  await writeBitrixRelations(dbFile, [
    { sourceType: "event", sourceName: "main:OnPageStart", targetType: "function", targetName: "pageStart", relationType: "handles", file: fileA, line: 10, module: "main", kind: "event" },
    { sourceType: "event", sourceName: "main:OnBeforeProlog", targetType: "method", targetName: "Handler::run", relationType: "handles", file: fileB, line: 20, module: "main", kind: "event" },
    { sourceType: "agent", sourceName: "Agent::run", targetType: "class", targetName: "Service", relationType: "calls", file: fileB, line: 30, module: "vendor.module", kind: "agent" }
  ]);

  assert.equal(await clearBitrixRelationsByKind(dbFile, "event"), 2);
  let remaining = await searchBitrixRelations(dbFile, { limit: 10 });
  assert.equal(remaining?.length, 1);
  assert.equal(remaining?.[0]?.kind, "agent");

  await writeBitrixRelations(dbFile, [
    { sourceType: "component", sourceName: "bitrix:news", targetType: "module", targetName: "iblock", relationType: "requires", file: fileA, line: 40, module: "iblock", kind: "component" },
    { sourceType: "orm", sourceName: "Vendor\\Table", targetType: "table", targetName: "b_vendor", relationType: "maps", file: fileB, line: 50, module: "vendor.module", kind: "orm" }
  ]);

  assert.equal(await clearBitrixRelationsByFile(dbFile, fileB), 2);
  remaining = await searchBitrixRelations(dbFile, { limit: 10 });
  assert.equal(remaining?.length, 1);
  assert.equal(remaining?.[0]?.file, fileA);
});

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




test("buildIndex indexes Bitrix agents and writes relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-agents-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-agents-data-"));
  const installFile = path.join(root, "local", "modules", "vendor.module", "install", "index.php");
  await fs.mkdir(path.dirname(installFile), { recursive: true });
  await fs.writeFile(installFile, String.raw`<?php
CAgent::AddAgent("\\Vendor\\Module\\Agent::run();", "vendor.module", "N", 86400);
CAgent::AddAgent("vendor_agent_run();", "vendor.module", "Y", 60);
`, "utf8");

  await buildIndex({ root, kind: "install", outFile: path.join(dataDir, "install-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);
  const agents = await searchAgents(dbFile, { module: "vendor.module", kind: "install", limit: 10 });

  const staticAgent = agents?.find((agent) => agent.name === "\\Vendor\\Module\\Agent::run");
  assert.equal(staticAgent?.periodic, "N");
  assert.equal(staticAgent?.interval, 86400);
  assert.equal(staticAgent?.relativeFile, path.join("local", "modules", "vendor.module", "install", "index.php"));

  const relations = await searchBitrixRelations(dbFile, { targetType: "agent", targetName: "\\Vendor\\Module\\Agent::run", limit: 10 });
  assert.ok(relations?.some((relation) => relation.sourceType === "module" && relation.sourceName === "vendor.module" && relation.relationType === "registers_agent"));
  assert.ok(relations?.some((relation) => relation.sourceType === "file" && relation.relationType === "registers_agent"));

  const methodRelations = await searchBitrixRelations(dbFile, { sourceType: "agent", sourceName: "\\Vendor\\Module\\Agent::run", targetType: "method", limit: 10 });
  assert.equal(methodRelations?.[0]?.relationType, "calls_method");
  assert.equal(methodRelations?.[0]?.targetName, "\\Vendor\\Module\\Agent::run");
});

test("buildIndex records PHP parse fallback diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-broken-php-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-broken-php-data-"));
  const brokenPath = path.join(root, "broken.php");
  await fs.writeFile(brokenPath, "<?php\nclass Broken { public function run( {\nAddEventHandler('main', 'OnPageStart', 'fallbackHandler');\n", "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json"), force: true });

  const dbFile = sqlitePath(dataDir);
  const status = await getIndexStatus(dbFile);
  assert.equal(status.phpParseFallbackFiles, 1);

  const warnings = await readIndexWarnings(dbFile, "project");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, "php_parse_fallback");
  assert.equal(warnings[0].file, brokenPath);
  assert.match(warnings[0].message, /unexpected|syntax|Expecting|Parse/i);

  const db = new DatabaseSync(dbFile);
  try {
    const meta = db.prepare("SELECT value FROM index_meta WHERE key = ?").get("index:project:warnings") as { value: string } | undefined;
    assert.ok(meta);
    const value = JSON.parse(meta.value) as { phpParseFallbackFiles: number; diagnostics: Array<{ file: string }> };
    assert.equal(value.phpParseFallbackFiles, 1);
    assert.equal(value.diagnostics[0].file, brokenPath);
  } finally {
    db.close();
  }

  const checks = await runDoctor({
    workspaceRoot: root,
    dataDir,
    docsDir: path.join(root, "docs"),
    docsPaths: [],
    embeddingsUrl: "http://127.0.0.1:9",
    semanticEnabled: false,
    officialDocsEnabled: false
  });
  const phpParseCheck = checks.find((check) => check.name === "phpParse");
  assert.equal(phpParseCheck?.status, "warning");
  assert.match(phpParseCheck?.message ?? "", /1 PHP file/);
});

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

test("LiveAPI search filters by kind arrays and prefers local results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-kind-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-kind-filter-"));
  await fs.mkdir(path.join(root, "bitrix/modules/main/lib"), { recursive: true });
  await fs.mkdir(path.join(root, "local/modules/vendor.module/install/js/admin"), { recursive: true });
  await fs.writeFile(path.join(root, "index.php"), "<?php\nfunction duplicate_boost_target(): void {}\nAddEventHandler('main', 'OnKindFilter', ['ProjectKindHandler', 'run']);\n", "utf8");
  await fs.writeFile(path.join(root, "bitrix/modules/main/lib/core.php"), "<?php\nfunction duplicate_boost_target(): void {}\nAddEventHandler('main', 'OnKindFilter', ['BitrixKindHandler', 'run']);\n", "utf8");
  await fs.writeFile(path.join(root, "local/modules/vendor.module/install/js/admin/widget.ts"), "export class InstallKindWidget {}\n", "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json") });
  await buildIndex({ root, kind: "bitrix", outFile: path.join(dataDir, "bitrix-index.json"), patterns: ["bitrix/modules/**/*.php"] });
  await buildIndex({ root, kind: "install", outFile: path.join(dataDir, "install-index.json") });

  const defaultResults = await searchLiveApi(sqlitePath(dataDir), { query: "duplicate_boost_target", type: "function", limit: 5 });
  assert.equal(defaultResults?.[0]?.item.name, "duplicate_boost_target");
  assert.equal(defaultResults?.[0]?.item.kind, "project");

  const bitrixOnlyResults = await searchLiveApi(sqlitePath(dataDir), { query: "duplicate_boost_target", type: "function", kind: ["bitrix"], limit: 5 });
  assert.ok(bitrixOnlyResults?.length);
  assert.ok(bitrixOnlyResults?.every((result) => result.item.kind === "bitrix"));

  const installOnlyResults = await searchLiveApi(sqlitePath(dataDir), { query: "InstallKindWidget", type: "class", kind: ["install"], limit: 5 });
  assert.equal(installOnlyResults?.[0]?.item.kind, "install");

  const defaultEventResults = await searchSqliteEvents(sqlitePath(dataDir), { query: "KindHandler", module: "main", limit: 5 });
  assert.equal(defaultEventResults?.[0]?.item.kind, "project");

  const bitrixEventResults = await searchSqliteEvents(sqlitePath(dataDir), { query: "KindHandler", module: "main", kind: "bitrix", limit: 5 });
  assert.ok(bitrixEventResults?.length);
  assert.ok(bitrixEventResults?.every((result) => result.item.kind === "bitrix"));
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


test("documentation chunks are prepared as embeddings documents", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-embedding-docs-"));
  await addPathDocSource(dataDir, path.join(fixtureRoot, "docs"));

  const chunks = await indexDocResourcesToSqlite(dataDir, [], { force: true });
  const documents = await prepareEmbeddingDocumentsFromSqlite(dataDir);

  assert.equal(documents.length, chunks);
  const headingDocument = documents.find((document) => document.text.includes("unique-heading-preservation-token"));
  assert.ok(headingDocument);
  assert.match(headingDocument.id, /^bitrix-docs:\/\/path-\d+\/framework\/markdown-headings\.md#chunk-\d+$/);
  assert.equal(headingDocument.metadata?.headingPath, "Framework Guide > Caching > Managed Cache Details");
  assert.equal(headingDocument.metadata?.sectionAnchor, "managed-cache-details");
  assert.equal(headingDocument.metadata?.relativePath, path.join("framework", "markdown-headings.md"));
});


test("doctor warns when semantic mode is enabled and embeddings document count differs from SQLite chunks", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doctor-embeddings-"));
  await addPathDocSource(dataDir, path.join(fixtureRoot, "docs"));
  const chunks = await indexDocResourcesToSqlite(dataDir, [], { force: true });

  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", model: "test-model", documents: Math.max(0, chunks - 1) }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const checks = await runDoctor({
      workspaceRoot: fixtureRoot,
      dataDir,
      docsDir: path.join(fixtureRoot, "docs"),
      docsPaths: [path.join(fixtureRoot, "docs")],
      embeddingsUrl: `http://127.0.0.1:${address.port}`,
      semanticEnabled: true,
      officialDocsEnabled: false
    });

    const embeddingsCheck = checks.find((check) => check.name === "embeddingsService");
    assert.equal(embeddingsCheck?.status, "warning");
    assert.match(embeddingsCheck?.message ?? "", /SQLite has \d+ documentation chunks/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("doctor skips embeddings health check when semantic mode is disabled", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doctor-semantic-disabled-"));
  let healthRequests = 0;

  const server = createServer((request, response) => {
    if (request.url === "/health") {
      healthRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "error", documents: 0 }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const checks = await runDoctor({
      workspaceRoot: fixtureRoot,
      dataDir,
      docsDir: path.join(fixtureRoot, "docs"),
      docsPaths: [path.join(fixtureRoot, "docs")],
      embeddingsUrl: `http://127.0.0.1:${address.port}`,
      semanticEnabled: false,
      officialDocsEnabled: false
    });

    assert.equal(healthRequests, 0);
    const embeddingsCheck = checks.find((check) => check.name === "embeddingsService");
    assert.equal(embeddingsCheck?.status, "info");
    assert.match(embeddingsCheck?.message ?? "", /Semantic search disabled/i);
    assert.match(formatDoctor([embeddingsCheck!]), /^INFO embeddingsService:/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

test("buildIndex writes event handler relations into bitrix_relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-event-relations-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-event-relations-data-"));
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), String.raw`<?php
EventManager::getInstance()->addEventHandler(
    'main',
    'OnBeforeProlog',
    ['Vendor\\Module\\Handler', 'onBeforeProlog']
);
AddEventHandler('sale', 'OnSaleOrderSaved', function () {});
`, "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json") });

  const eventToHandler = await searchBitrixRelations(sqlitePath(dataDir), {
    sourceType: "event",
    sourceName: "main:OnBeforeProlog",
    relationType: "handles_event",
    limit: 5
  });
  assert.equal(eventToHandler?.[0]?.targetType, "method");
  assert.equal(eventToHandler?.[0]?.targetName, "Vendor\\Module\\Handler::onBeforeProlog");
  assert.equal(eventToHandler?.[0]?.module, "main");
  assert.equal(eventToHandler?.[0]?.kind, "project");

  const fileToEvent = await searchBitrixRelations(sqlitePath(dataDir), {
    sourceType: "file",
    sourceName: path.join("local", "php_interface", "init.php"),
    targetType: "event",
    targetName: "main:OnBeforeProlog",
    relationType: "registers_event_handler",
    limit: 5
  });
  assert.equal(fileToEvent?.[0]?.file, path.join(root, "local/php_interface/init.php"));
  assert.match(fileToEvent?.[0]?.signature ?? "", /addEventHandler/);

  const closureRelation = await searchBitrixRelations(sqlitePath(dataDir), {
    sourceType: "event",
    sourceName: "sale:OnSaleOrderSaved",
    relationType: "handles_event",
    limit: 5
  });
  assert.equal(closureRelation?.[0]?.targetType, "function");
  assert.equal(closureRelation?.[0]?.targetName, "closure");
  assert.deepEqual(closureRelation?.[0]?.metadata, { anonymous: true });
});


test("buildIndex writes module usage records and file-to-module relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-module-usage-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-module-usage-data-"));
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), String.raw`<?php
Loader::includeModule('iblock');
Loader::includeModule($dynamicModule);
ModuleManager::isModuleInstalled('sale');
`, "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json") });

  const usages = await searchModuleUsages(sqlitePath(dataDir), { module: "iblock", limit: 5 });
  assert.equal(usages?.length, 1);
  assert.equal(usages?.[0]?.call, "Loader::includeModule");
  assert.equal(usages?.[0]?.kind, "project");
  assert.equal(usages?.[0]?.relativeFile, path.join("local", "php_interface", "init.php"));
  assert.match(usages?.[0]?.signature ?? "", /Loader::includeModule\('iblock'\)/);

  const allUsages = await searchModuleUsages(sqlitePath(dataDir), { limit: 10 });
  assert.deepEqual(allUsages?.map((usage) => usage.module).sort(), ["iblock", "sale"]);

  const relations = await searchBitrixRelations(sqlitePath(dataDir), {
    sourceType: "file",
    sourceName: path.join("local", "php_interface", "init.php"),
    targetType: "module",
    targetName: "iblock",
    relationType: "includes_module",
    limit: 5
  });
  assert.equal(relations?.[0]?.module, "iblock");
  assert.equal(relations?.[0]?.kind, "project");
  assert.deepEqual(relations?.[0]?.metadata, { call: "Loader::includeModule" });
});

test("buildIndex indexes Bitrix mail events and writes mail handler relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-mail-events-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-mail-events-data-"));
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/service.php"), String.raw`<?php
CEvent::Send('SALE_NEW_ORDER', SITE_ID, $fields);
CEvent::SendImmediate('SALE_STATUS_CHANGED', 's1', $fields);
\CEvent::Send('SALE_CANCEL_ORDER', 's2', $fields);
\Bitrix\Main\Mail\Event::send([
    'EVENT_NAME' => 'SALE_DELIVERY',
    'LID' => 's3',
    'C_FIELDS' => ['ID' => 1],
]);
CEvent::Send($dynamicEvent, SITE_ID, $fields);
`, "utf8");
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), String.raw`<?php
AddEventHandler('main', 'OnBeforeEventSend', ['MailHandlers', 'beforeSend']);
\Bitrix\Main\EventManager::getInstance()->addEventHandler('main', 'OnBeforeEventAdd', 'beforeEventAdd');
`, "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);

  const mailEvents = await searchMailEvents(dbFile, { eventName: "SALE_NEW_ORDER", includeHandlers: true, limit: 10 });
  assert.equal(mailEvents?.length, 1);
  assert.equal(mailEvents?.[0]?.api, "CEvent::Send");
  assert.equal(mailEvents?.[0]?.siteId, "SITE_ID");
  assert.equal(mailEvents?.[0]?.relativeFile, path.join("local", "php_interface", "service.php"));
  assert.equal(mailEvents?.[0]?.handlers?.length, 2);
  assert.ok(mailEvents?.[0]?.handlers?.some((handler) => handler.eventName === "OnBeforeEventSend" && handler.handlerClass === "MailHandlers"));

  const immediateEvents = await searchMailEvents(dbFile, { api: "CEvent::SendImmediate", limit: 10 });
  assert.equal(immediateEvents?.[0]?.eventName, "SALE_STATUS_CHANGED");

  const d7Events = await searchMailEvents(dbFile, { query: "SALE_DELIVERY", limit: 10 });
  assert.equal(d7Events?.[0]?.api, "Bitrix\\Main\\Mail\\Event::send");
  assert.equal(d7Events?.[0]?.siteId, "s3");

  const dynamicEvents = await searchMailEvents(dbFile, { query: "CEvent::Send", limit: 10 });
  assert.ok(dynamicEvents?.some((event) => event.eventName === undefined && event.name === "CEvent::Send"));

  const fileRelations = await searchBitrixRelations(dbFile, {
    sourceType: "file",
    sourceName: path.join("local", "php_interface", "service.php"),
    targetType: "mail_event",
    targetName: "SALE_NEW_ORDER",
    relationType: "sends_mail_event",
    limit: 10
  });
  assert.equal(fileRelations?.[0]?.metadata?.api, "CEvent::Send");
  assert.equal(fileRelations?.[0]?.metadata?.siteId, "SITE_ID");

  const handlerRelations = await searchBitrixRelations(dbFile, {
    sourceType: "mail_event",
    sourceName: "SALE_NEW_ORDER",
    targetType: "event_handler",
    relationType: "handled_by_event_handler",
    limit: 10
  });
  assert.ok(handlerRelations?.some((relation) => relation.targetName.includes("OnBeforeEventSend")));
  assert.ok(handlerRelations?.some((relation) => relation.targetName.includes("OnBeforeEventAdd")));
});

test("buildIndex stores D7 ORM entities, usages, and relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-orm-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-orm-data-"));
  const productFile = path.join(root, "local", "modules", "vendor.module", "lib", "product.php");
  const usageFile = path.join(root, "local", "modules", "vendor.module", "lib", "usage.php");
  await fs.mkdir(path.dirname(productFile), { recursive: true });
  await fs.writeFile(productFile, String.raw`<?php
namespace Vendor\Module;
use Bitrix\Main\ORM\Data\DataManager;
class ProductTable extends DataManager
{
    public static function getTableName() { return 'vendor_product'; }
    public static function getMap() {
        return [
            new IntegerField('ID', ['primary' => true, 'autocomplete' => true]),
            new StringField('NAME', ['required' => true, 'default_value' => '']),
            new TextField('DESCRIPTION'),
            new BooleanField('ACTIVE'),
            new DatetimeField('CREATED_AT'),
            new DateField('DATE'),
            new EnumField('TYPE', ['values' => ['simple', 'sku']]),
            new ExpressionField('FULL_NAME', 'concat(%s, %s)', ['NAME', 'TYPE']),
            new ReferenceField('USER', UserTable::class, ['=this.USER_ID' => 'ref.ID']),
            new OneToMany('ITEMS', ItemTable::class, 'PRODUCT'),
            new ManyToMany('SECTIONS', SectionTable::class),
        ];
    }
}
`, "utf8");
  await fs.writeFile(usageFile, String.raw`<?php
namespace Vendor\Module;
ProductTable::query();
ProductTable::getList([]);
ProductTable::getById(1);
ProductTable::add([]);
ProductTable::update(1, []);
ProductTable::delete(1);
Section::compileEntityByIblock(7);
`, "utf8");

  await buildIndex({ root, kind: "bitrix", outFile: path.join(dataDir, "bitrix-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);

  const entities = await searchOrmEntities(dbFile, { tableName: "vendor_product", limit: 5 });
  assert.equal(entities?.length, 1);
  assert.equal(entities?.[0]?.className, "Vendor\\Module\\ProductTable");
  assert.equal(entities?.[0]?.fields.length, 11);
  assert.equal(entities?.[0]?.fields.find((field) => field.name === "ID")?.options?.primary, true);
  assert.equal(entities?.[0]?.fields.find((field) => field.name === "TYPE")?.options?.values instanceof Array, true);
  assert.equal(entities?.[0]?.references.find((field) => field.name === "USER")?.referenceClass, "Vendor\\Module\\UserTable");

  const maps = await getOrmEntityMap(dbFile, { className: "Vendor\\Module\\ProductTable" });
  assert.equal(maps?.[0]?.tableName, "vendor_product");

  const usages = await searchOrmUsages(dbFile, { entity: "Vendor\\Module\\ProductTable", limit: 10 });
  assert.equal(usages?.filter((usage) => usage.usageKind === "datamanager").length, 6);
  assert.ok(usages?.some((usage) => usage.method === "getList"));
  const compileUsages = await searchOrmUsages(dbFile, { method: "compileEntityByIblock", limit: 10 });
  assert.equal(compileUsages?.[0]?.usageKind, "compile_entity_by_iblock");

  const tableRelations = await searchBitrixRelations(dbFile, { sourceType: "orm_entity", sourceName: "Vendor\\Module\\ProductTable", targetType: "table", targetName: "vendor_product", limit: 10 });
  assert.equal(tableRelations?.[0]?.relationType, "maps_table");
  const referenceRelations = await searchBitrixRelations(dbFile, { sourceType: "orm_entity", sourceName: "Vendor\\Module\\ProductTable", relationType: "references_orm_entity", limit: 10 });
  assert.ok(referenceRelations?.some((relation) => relation.targetName === "Vendor\\Module\\UserTable"));
  const usageRelations = await searchBitrixRelations(dbFile, { sourceType: "file", targetType: "orm_entity", targetName: "Vendor\\Module\\ProductTable", relationType: "uses_orm_entity", limit: 10 });
  assert.ok((usageRelations?.length ?? 0) >= 6);
});


test("buildIndex indexes IBlock API usages and writes IBlock relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-iblock-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-iblock-data-"));
  const usageFile = path.join(root, "local", "php_interface", "iblock.php");
  await fs.mkdir(path.dirname(usageFile), { recursive: true });
  await fs.writeFile(usageFile, String.raw`<?php
const NEWS_IBLOCK_ID = 8;
define('CATALOG_IBLOCK_ID', 12);
class CatalogUsage
{
    public function load($iblockId) {
        CIBlockElement::GetList([], ["IBLOCK_ID" => 12, "ACTIVE" => "Y"]);
        CIBlockElement::GetList([], ['IBLOCK_ID' => CATALOG_IBLOCK_ID]);
        CIBlockSection::GetList([], ['IBLOCK_ID' => NEWS_IBLOCK_ID]);
        CIBlockElement::SetPropertyValuesEx(1, $iblockId, ['COLOR' => 'red']);
        \Bitrix\Iblock\ElementTable::getList(['filter' => ['IBLOCK_ID' => $iblockId]]);
    }
}
`, "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);

  const numericUsages = await searchIblockUsages(dbFile, { iblockId: "12", api: "CIBlockElement::GetList", limit: 10 });
  assert.equal(numericUsages?.length, 1);
  assert.equal(numericUsages?.[0]?.kind, "project");
  assert.equal(numericUsages?.[0]?.relativeFile, path.join("local", "php_interface", "iblock.php"));

  const constantUsages = await searchIblockUsages(dbFile, { iblockId: "CATALOG_IBLOCK_ID", limit: 10 });
  assert.equal(constantUsages?.[0]?.api, "CIBlockElement::GetList");

  const sectionUsages = await searchIblockUsages(dbFile, { api: "CIBlockSection::GetList", limit: 10 });
  assert.equal(sectionUsages?.[0]?.iblockId, "NEWS_IBLOCK_ID");

  const propertyUsages = await searchIblockUsages(dbFile, { api: "CIBlockElement::SetPropertyValuesEx", limit: 10 });
  assert.equal(propertyUsages?.[0]?.iblockId, "unknown");

  const d7Usages = await searchIblockUsages(dbFile, { api: "Bitrix\\Iblock\\ElementTable::getList", limit: 10 });
  assert.equal(d7Usages?.[0]?.iblockId, "$iblockId");
  assert.equal(d7Usages?.[0]?.contextName, "CatalogUsage::load");

  const fileRelations = await searchBitrixRelations(dbFile, { sourceType: "file", targetType: "iblock", targetName: "12", relationType: "uses_iblock", limit: 10 });
  assert.equal(fileRelations?.[0]?.module, "iblock");
  assert.equal(fileRelations?.[0]?.kind, "project");
  assert.equal(fileRelations?.[0]?.metadata?.api, "CIBlockElement::GetList");

  const methodRelations = await searchBitrixRelations(dbFile, { sourceType: "method", sourceName: "CatalogUsage::load", targetType: "iblock", targetName: "$iblockId", relationType: "uses_iblock", limit: 10 });
  assert.ok((methodRelations?.length ?? 0) >= 1);
});

test("buildIndex indexes Highloadblock API usages and writes Highloadblock relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-hlblock-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-hlblock-data-"));
  const usageFile = path.join(root, "local", "php_interface", "hlblock.php");
  await fs.mkdir(path.dirname(usageFile), { recursive: true });
  await fs.writeFile(usageFile, String.raw`<?php
use Bitrix\Highloadblock\HighloadBlockTable;
function loadHl($dynamicId) {
    HighloadBlockTable::getById(3);
    HighloadBlockTable::getList(["filter" => ["HLBLOCK_ID" => 3]]);
    HighloadBlockTable::compileEntity($hlblock);
    \Bitrix\Highloadblock\HighloadBlockTable::compileEntity(['ID' => HLBLOCK_CODE]);
    \Bitrix\Highloadblock\HighloadBlockTable::getList(['filter' => ['HLBLOCK_ID' => $dynamicId]]);
}
`, "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);

  const byIdUsages = await searchHlblockUsages(dbFile, { hlblockId: "3", api: "HighloadBlockTable::getById", limit: 10 });
  assert.equal(byIdUsages?.length, 1);
  assert.equal(byIdUsages?.[0]?.kind, "project");
  assert.equal(byIdUsages?.[0]?.relativeFile, path.join("local", "php_interface", "hlblock.php"));

  const listUsages = await searchHlblockUsages(dbFile, { api: "HighloadBlockTable::getList", limit: 10 });
  assert.ok(listUsages?.some((usage) => usage.hlblockId === "3"));
  assert.ok(listUsages?.some((usage) => usage.hlblockId === "unknown"));

  const compileUsages = await searchHlblockUsages(dbFile, { api: "HighloadBlockTable::compileEntity", limit: 10 });
  assert.ok(compileUsages?.some((usage) => usage.hlblockId === "HLBLOCK_CODE"));
  assert.ok(compileUsages?.some((usage) => usage.hlblockId === "unknown"));

  const fileRelations = await searchBitrixRelations(dbFile, { sourceType: "file", targetType: "hlblock", targetName: "3", relationType: "uses_hlblock", limit: 10 });
  assert.equal(fileRelations?.[0]?.module, "highloadblock");
  assert.equal(fileRelations?.[0]?.kind, "project");
  assert.ok(fileRelations?.some((relation) => relation.metadata?.api === "HighloadBlockTable::getById"));

  const functionRelations = await searchBitrixRelations(dbFile, { sourceType: "function", sourceName: "loadHl", targetType: "hlblock", targetName: "HLBLOCK_CODE", relationType: "uses_hlblock", limit: 10 });
  assert.ok((functionRelations?.length ?? 0) >= 1);
});

test("component template path resolution covers site and source templates", () => {
  assert.deepEqual(possibleComponentTemplateRelativePaths("bitrix:catalog.section", ".default"), [
    "local/templates/<site>/components/bitrix/catalog.section/.default",
    "bitrix/templates/<site>/components/bitrix/catalog.section/.default",
    "local/components/bitrix/catalog.section/templates/.default",
    "bitrix/components/bitrix/catalog.section/templates/.default"
  ]);
  assert.deepEqual(possibleComponentTemplateRelativePaths("vendor:demo", ".default"), [
    "local/templates/<site>/components/vendor/demo/.default",
    "bitrix/templates/<site>/components/vendor/demo/.default",
    "local/components/vendor/demo/templates/.default",
    "bitrix/components/vendor/demo/templates/.default"
  ]);
});

test("buildIndex indexes component calls, files, params, relations, and context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-components-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-components-data-"));
  const callFile = path.join(root, "index.php");
  const templateDir = path.join(root, "local", "templates", "site", "components", "bitrix", "catalog.section", ".default");
  const sourceTemplateDir = path.join(root, "local", "components", "bitrix", "catalog.section", "templates", ".default");
  await fs.mkdir(templateDir, { recursive: true });
  await fs.mkdir(sourceTemplateDir, { recursive: true });
  await fs.writeFile(callFile, String.raw`<?php
$APPLICATION->IncludeComponent(
  "bitrix:catalog.section",
  "",
  ["IBLOCK_ID" => 42, "CACHE_TYPE" => "A", "CACHE_TIME" => 3600]
);
$APPLICATION->IncludeComponent('vendor:demo', '.default', ['AJAX_MODE' => 'Y']);
`, "utf8");
  await fs.writeFile(path.join(templateDir, "template.php"), "<?php echo 'template';\n", "utf8");
  await fs.writeFile(path.join(templateDir, "result_modifier.php"), "<?php $arResult['X'] = 1;\n", "utf8");
  await fs.writeFile(path.join(templateDir, "script.js"), "console.log('asset');\n", "utf8");
  await fs.writeFile(path.join(templateDir, "style.css"), ".catalog{}\n", "utf8");
  await fs.writeFile(path.join(sourceTemplateDir, ".parameters.php"), "<?php $arComponentParameters = [];\n", "utf8");

  await buildIndex({ root, kind: "project", outFile: path.join(dataDir, "project-index.json"), force: true });
  await buildIndex({ root, kind: "template", outFile: path.join(dataDir, "template-index.json"), force: true });
  const dbFile = sqlitePath(dataDir);

  const components = await searchComponents(dbFile, { component: "bitrix:catalog.section", limit: 10 });
  assert.equal(components?.length, 1);
  assert.equal(components?.[0]?.template, ".default");
  assert.deepEqual(components?.[0]?.params, [
    { name: "IBLOCK_ID", value: 42 },
    { name: "CACHE_TYPE", value: "A" },
    { name: "CACHE_TIME", value: 3600 }
  ]);

  const relations = await searchBitrixRelations(dbFile, { sourceType: "component", sourceName: "bitrix:catalog.section", limit: 20 });
  assert.ok(relations?.some((relation) => relation.relationType === "uses_template"));
  assert.ok(relations?.some((relation) => relation.relationType === "uses_iblock" && relation.targetName === "42"));
  assert.ok(relations?.some((relation) => relation.relationType === "component_template_file" && relation.targetName.endsWith("template.php")));
  assert.ok(relations?.some((relation) => relation.relationType === "component_asset" && relation.targetName.endsWith("script.js")));

  const context = await getComponentContext(dbFile, { component: "bitrix:catalog.section", template: ".default" });
  assert.equal(context?.component, "bitrix:catalog.section");
  assert.equal(context?.template, ".default");
  assert.equal(context?.calls.length, 1);
  assert.ok(context?.templateFiles.some((file) => file.relativePath.endsWith("template.php")));
  assert.ok(context?.templateFiles.some((file) => file.relativePath.endsWith(".parameters.php")));
  assert.ok(context?.assets.some((file) => file.relativePath.endsWith("script.js")));
  assert.ok(context?.parameters.some((param) => param.name === "IBLOCK_ID" && param.value === 42));
  assert.ok(context?.relations.some((relation) => relation.relationType === "uses_template"));
});
