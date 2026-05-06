import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex, readIndex } from "../src/indexer/indexer.js";
import { sqlitePath } from "../src/config/paths.js";
import { indexDocResourcesToSqlite } from "../src/resources/docs.js";
import { searchLiveApi, searchSqliteDocs } from "../src/liveapi/search.js";

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
});

test("SQLite FTS searches classes, methods, events, and docs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-fts-"));
  const outFile = path.join(dataDir, "project-index.json");
  await buildIndex({ root: fixtureRoot, kind: "project", outFile });

  const classResults = await searchLiveApi(sqlitePath(dataDir), { query: "DemoComponent", type: "class", limit: 5 });
  assert.equal(classResults?.[0]?.item.name, "DemoComponent");

  const methodResults = await searchLiveApi(sqlitePath(dataDir), { query: "execute", type: "method", limit: 5 });
  assert.equal(methodResults?.[0]?.item.name, "executeComponent");

  const eventResults = await searchLiveApi(sqlitePath(dataDir), { query: "OnBefore", type: "event", module: "main", limit: 5 });
  assert.equal(eventResults?.[0]?.item.name, "main:OnBeforeProlog");

  await indexDocResourcesToSqlite(path.join(fixtureRoot, "docs"), dataDir);
  const docResults = await searchSqliteDocs(sqlitePath(dataDir), { query: "managed cache", limit: 5 });
  assert.match(docResults?.[0]?.item.text ?? "", /managed cache/);
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
