import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { searchLiveApi } from "../src/liveapi/search.js";

test("buildIndex indexes project PHP symbols", async () => {
  const root = path.resolve("tests/fixtures/project");
  const outFile = path.join(os.tmpdir(), `bitrix-mcp-project-${Date.now()}.json`);
  const manifest = await buildIndex({ root, kind: "project", outFile });
  assert.ok(manifest.files.length >= 2);
  const results = searchLiveApi([manifest], { query: "demo_helper" });
  assert.equal(results[0]?.item.name, "demo_helper");
});

test("template index uses template-specific patterns", async () => {
  const root = path.resolve("tests/fixtures/project");
  const outFile = path.join(os.tmpdir(), `bitrix-mcp-template-${Date.now()}.json`);
  const manifest = await buildIndex({ root, kind: "template", outFile });
  assert.ok(manifest.files.every((file) => file.relativePath.includes("templates")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "template_helper")));
});
