import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex, readIndex } from "../src/indexer/indexer.js";
import { sqlitePath } from "../src/config/paths.js";
import { searchSqliteLiveApi } from "../src/indexer/sqliteStore.js";
import { searchLiveApi } from "../src/liveapi/search.js";

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
  const results = await searchSqliteLiveApi(sqlitePath(dataDir), { query: "demo_helper" });
  assert.equal(results?.[0]?.item.name, "demo_helper");
  assert.equal(searchLiveApi([manifest], { query: "demo_helper" })[0]?.item.name, "demo_helper");
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
