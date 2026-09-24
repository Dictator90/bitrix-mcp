import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqlitePath } from "../src/config/paths.js";
import { openDatabase } from "../src/indexer/database.js";
import { buildIndex } from "../src/indexer/indexer.js";
import { ensureSqliteStore } from "../src/indexer/sqliteStore.js";
import { indexDocResourcesToSqlite } from "../src/resources/docs.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../src/liveapi/search.js";
import { codeFtsQuery, identifierTokens, stemRussian } from "../src/search/textTokens.js";

test("identifier tokens split camelCase, namespaces, snake_case and the legacy C prefix", () => {
  assert.ok(identifierTokens("CIBlockElement").includes("iblock"));
  assert.ok(identifierTokens("CIBlockElement").includes("element"));
  assert.ok(identifierTokens("Bitrix\\Main\\Loader::includeModule").includes("include"));
  assert.ok(identifierTokens("b_iblock_element").includes("iblock"));
  assert.equal(codeFtsQuery("getList"), '("getlist"* OR ("get"* AND "list"*))');
});

test("Russian stemmer folds common inflections", () => {
  for (const [a, b] of [["событие", "событий"], ["обработчики", "обработчика"], ["инфоблоки", "инфоблоков"], ["компонент", "компонентах"]]) {
    assert.equal(stemRussian(a), stemRussian(b), `${a} / ${b}`);
  }
});

async function indexFixture(): Promise<{ root: string; dataDir: string; dbFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-search-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-search-data-"));
  await fs.mkdir(path.join(root, "bitrix/modules/iblock/classes"), { recursive: true });
  await fs.writeFile(path.join(root, "bitrix/modules/iblock/classes/iblockelement.php"), [
    "<?php",
    "class CIBlockElement {",
    "  public static function GetList($order = [], $filter = []) {}",
    "}"
  ].join("\n"), "utf8");
  await fs.mkdir(path.join(root, "bitrix/modules/main/lib"), { recursive: true });
  await fs.writeFile(path.join(root, "bitrix/modules/main/lib/loader.php"), "<?php\nnamespace Bitrix\\Main;\nclass Loader { public static function includeModule($name) {} }\n", "utf8");
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), [
    "<?php",
    "AddEventHandler('iblock', 'OnBeforeIBlockElementAdd', ['LocalHandlers', 'beforeElementAdd']);",
    "/** Helper that mentions iblock only in its description text. */",
    "function unrelated_helper() {}"
  ].join("\n"), "utf8");
  const dataDirDb = sqlitePath(dataDir);
  await buildIndex({ root, kind: "bitrix", dbFile: dataDirDb, patterns: ["bitrix/**/*.php"] });
  await buildIndex({ root, kind: "project", dbFile: dataDirDb });
  return { root, dataDir, dbFile: dataDirDb };
}

test("symbol search finds names by their parts and ranks exact matches first", async () => {
  const { root, dataDir, dbFile } = await indexFixture();
  try {
    const names = async (query: string, extra: Record<string, unknown> = {}) => (await searchLiveApi(dbFile, { query, ...extra }))?.map((result) => result.item.name) ?? [];
    assert.ok((await names("iblock")).includes("CIBlockElement"), "camelCase part");
    assert.equal((await names("IBlockElement"))[0], "CIBlockElement");
    assert.ok((await names("getlist")).some((name) => name.endsWith("GetList")), "method by member name");
    assert.equal((await names("Bitrix\\Main\\Loader"))[0], "Bitrix\\Main\\Loader", "by FQN");
    assert.equal((await names("Loader"))[0], "Bitrix\\Main\\Loader", "by short class name");
    const exact = await searchLiveApi(dbFile, { query: "CIBlockElement" });
    assert.equal(exact?.[0]?.item.name, "CIBlockElement");
    assert.equal(exact?.[0]?.score, 1);
    assert.deepEqual(await names("definitely_missing_symbol"), []);

    const events = await searchSqliteEvents(dbFile, { query: "ElementAdd" });
    assert.equal(events?.[0]?.item.eventName, "OnBeforeIBlockElementAdd");
    const qualified = await searchSqliteEvents(dbFile, { query: "iblock:OnBeforeIBlockElementAdd" });
    assert.equal(qualified?.[0]?.score, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("docs search matches Russian inflections and English stems", async () => {
  const docsDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-search-docs-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-search-docs-data-"));
  try {
    await fs.writeFile(path.join(docsDir, "events.md"), "# Обработчики событий\n\nСобытие OnBeforeIBlockElementAdd вызывается перед добавлением элемента.\n", "utf8");
    await fs.writeFile(path.join(docsDir, "cache.md"), "# Caching\n\nComponents cache their results between requests.\n", "utf8");
    await indexDocResourcesToSqlite(dataDir, [docsDir], { includeOfficialDocs: false });
    const dbFile = sqlitePath(dataDir);
    const russian = await searchSqliteDocs(dbFile, { query: "обработчик события" });
    assert.equal(russian?.[0]?.item.title, "Обработчики событий");
    const english = await searchSqliteDocs(dbFile, { query: "cached component" });
    assert.equal(english?.[0]?.item.title, "Caching");
  } finally {
    await fs.rm(docsDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("old FTS tables are rebuilt with tokens on migration", async () => {
  const { root, dataDir, dbFile } = await indexFixture();
  try {
    // Recreate a pre-0.9 symbols_fts (no tokens column, stored content) and mark the schema as v4.
    const db = openDatabase(dbFile);
    db.exec("DROP TABLE symbols_fts; CREATE VIRTUAL TABLE symbols_fts USING fts5(name, type, module, class_name, signature, description); PRAGMA user_version = 4;");
    db.close();
    // A copy has a new file identity, so this process migrates it again.
    const copy = path.join(dataDir, "copy.sqlite");
    await fs.copyFile(dbFile, copy);
    await ensureSqliteStore(copy);
    const results = await searchLiveApi(copy, { query: "iblock" });
    assert.ok(results?.some((result) => result.item.name === "CIBlockElement"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
