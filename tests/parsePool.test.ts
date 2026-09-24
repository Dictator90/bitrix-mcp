import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqlitePath } from "../src/config/paths.js";
import { buildIndex } from "../src/indexer/indexer.js";
import { indexWorkerCount, ParsePool } from "../src/indexer/parsePool.js";
import { parseFile } from "../src/indexer/parseFile.js";
import { searchLiveApi } from "../src/liveapi/search.js";

test("indexWorkerCount honours BITRIX_MCP_INDEX_WORKERS", () => {
  assert.equal(indexWorkerCount({ BITRIX_MCP_INDEX_WORKERS: "3" }), 3);
  assert.equal(indexWorkerCount({ BITRIX_MCP_INDEX_WORKERS: "1" }), 1);
  assert.ok(indexWorkerCount({}) >= 1 && indexWorkerCount({}) <= 4);
});

test("ParsePool parses like the in-process parser and reports per-file errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-pool-"));
  const pool = new ParsePool(2);
  try {
    const php = path.join(root, "a.php");
    const js = path.join(root, "b.js");
    await fs.writeFile(php, "<?php\nnamespace App;\nclass Service { public function run() { \\Bitrix\\Main\\Loader::includeModule('iblock'); } }\n", "utf8");
    await fs.writeFile(js, "export class Widget { render() {} }\n", "utf8");
    assert.deepEqual(await pool.parse(php, "php"), await parseFile(php, "php"));
    assert.deepEqual(await pool.parse(js, "javascript"), await parseFile(js, "javascript"));
    await assert.rejects(pool.parse(path.join(root, "missing.php"), "php"), /ENOENT/);
  } finally {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("large runs parse in worker threads with the same index result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-pool-root-"));
  const serialData = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-pool-serial-"));
  const parallelData = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-pool-parallel-"));
  const previous = process.env.BITRIX_MCP_INDEX_WORKERS;
  try {
    for (let index = 0; index < 220; index += 1) {
      await fs.writeFile(path.join(root, `f${index}.php`), `<?php\nfunction pool_fn_${index}() { CIBlockElement::GetList([], ['IBLOCK_ID' => ${index}]); }\n`, "utf8");
    }
    await fs.writeFile(path.join(root, "broken.php"), "<?php\nfunction broken( {\n", "utf8");

    process.env.BITRIX_MCP_INDEX_WORKERS = "1";
    const serial = await buildIndex({ root, kind: "project", dbFile: sqlitePath(serialData) });
    process.env.BITRIX_MCP_INDEX_WORKERS = "3";
    const parallel = await buildIndex({ root, kind: "project", dbFile: sqlitePath(parallelData) });

    const symbolsOf = (manifest: typeof serial) => manifest.files.flatMap((file) => file.symbols.map((symbol) => `${file.relativePath}:${symbol.type}:${symbol.name}`)).sort();
    assert.equal(parallel.files.length, 221);
    assert.deepEqual(symbolsOf(parallel), symbolsOf(serial));
    const hit = await searchLiveApi(sqlitePath(parallelData), { query: "pool_fn_219" });
    assert.equal(hit?.[0]?.item.name, "pool_fn_219");
  } finally {
    if (previous === undefined) delete process.env.BITRIX_MCP_INDEX_WORKERS;
    else process.env.BITRIX_MCP_INDEX_WORKERS = previous;
    for (const dir of [root, serialData, parallelData]) await fs.rm(dir, { recursive: true, force: true });
  }
});
