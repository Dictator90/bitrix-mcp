import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeSource, parseFile } from "../src/indexer/parseFile.js";

// "Привет" in Windows-1251.
const CP1251_PRIVET = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];

test("decodeSource keeps UTF-8, strips the BOM, and falls back to Windows-1251", () => {
  assert.equal(decodeSource(Buffer.from("Привет", "utf8")), "Привет");
  assert.equal(decodeSource(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("<?php", "utf8")])), "<?php");
  assert.equal(decodeSource(Buffer.from(CP1251_PRIVET)), "Привет");
});

test("parseFile decodes legacy cp1251 PHP sources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cp1251-"));
  const file = path.join(dir, "legacy.php");
  const prefix = Buffer.from("<?php\n/**\n * ", "latin1");
  const suffix = Buffer.from("\n */\nclass LegacyCp1251 {}\n", "latin1");
  await fs.writeFile(file, Buffer.concat([prefix, Buffer.from(CP1251_PRIVET), suffix]));
  const parsed = await parseFile(file, "php");
  const symbol = parsed.symbols.find((item) => item.name === "LegacyCp1251");
  assert.equal(symbol?.description, "Привет");
  assert.deepEqual(parsed.warnings, []);
});
