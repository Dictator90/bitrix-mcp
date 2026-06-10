import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseModuleSelection,
  resolveBitrixIndex,
  validateBitrixModules
} from "../src/indexer/bitrixModules.js";

test("parseModuleSelection parses lists, all, and empty", () => {
  assert.deepEqual(parseModuleSelection("main,iblock"), ["main", "iblock"]);
  assert.deepEqual(parseModuleSelection(" main , iblock , "), ["main", "iblock"]);
  assert.equal(parseModuleSelection("all"), "all");
  assert.equal(parseModuleSelection(""), "all");
  assert.equal(parseModuleSelection(undefined), undefined);
});

test("resolveBitrixIndex restricts modules to the allowlist but keeps admin/tools/js", () => {
  const resolved = resolveBitrixIndex({ modules: ["main", "iblock"] });
  assert.ok(resolved.patterns.includes("bitrix/modules/main/**/*.php"));
  assert.ok(resolved.patterns.includes("bitrix/modules/iblock/**/*.php"));
  assert.ok(!resolved.patterns.includes("bitrix/modules/**/*.php"), "should not glob all bitrix modules");
  assert.ok(resolved.patterns.includes("bitrix/admin/**/*.php"));
  assert.ok(resolved.patterns.includes("bitrix/tools/**/*.php"));
  assert.ok(resolved.patterns.some((pattern) => pattern.startsWith("bitrix/js/")));
});

test("resolveBitrixIndex with all modules globs every module", () => {
  const resolved = resolveBitrixIndex({ modules: "all" });
  assert.ok(resolved.patterns.includes("bitrix/modules/**/*.php"));
});

test("resolveBitrixIndex excludes lang by default and keeps it with includeLang", () => {
  const fast = resolveBitrixIndex({ modules: "all" });
  assert.ok(fast.ignores.some((rule) => rule.includes("/lang/")), "lang excluded by default");

  const full = resolveBitrixIndex({ modules: "all", includeLang: true });
  assert.ok(!full.ignores.some((rule) => rule.includes("/lang/")), "lang kept with includeLang");
});

test("validateBitrixModules reports missing modules without throwing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-modval-"));
  await fs.mkdir(path.join(root, "bitrix", "modules", "main"), { recursive: true });
  await fs.mkdir(path.join(root, "bitrix", "modules", "iblock"), { recursive: true });

  const result = await validateBitrixModules(root, ["main", "iblock", "nope"]);
  assert.deepEqual(result.found.sort(), ["iblock", "main"]);
  assert.deepEqual(result.missing, ["nope"]);

  assert.deepEqual(await validateBitrixModules(root, "all"), { found: [], missing: [] });
});
