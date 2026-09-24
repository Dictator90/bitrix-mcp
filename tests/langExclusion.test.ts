import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { sqlitePath } from "../src/config/paths.js";
import { searchBitrixFeatures } from "../src/indexer/sqliteStore.js";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

async function makeTemplateFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-lang-"));
  await write(root, "local/templates/main/header.php", "<?php\nfunction tmpl_header(): void {}\n");
  await write(root, "local/templates/main/lang/ru/header.php", "<?php\n$MESS['TITLE'] = 'X';\n");
  await write(root, "bitrix/components/bitrix/news.list/lang/ru/.description.php", "<?php\n$MESS['NAME'] = 'News';\n");
  return root;
}

test("template scope indexes lang/ phrases; the bitrix scope still excludes lang/ by default", async () => {
  const root = await makeTemplateFixture();
  await write(root, "bitrix/modules/main/lang/ru/include.php", "<?php\n$MESS['CORE_PHRASE'] = 'Core';\n");
  await write(root, "bitrix/modules/main/include.php", "<?php\nfunction core_fn(): void {}\n");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-lang-db-"));
  const dbFile = sqlitePath(dataDir);

  const manifest = await buildIndex({ root, kind: "template", dbFile, force: true });
  const paths = manifest.files.map((file) => file.relativePath.replace(/\\/g, "/"));
  assert.ok(paths.includes("local/templates/main/header.php"), `template code should be indexed: ${paths.join(", ")}`);
  assert.ok(paths.includes("local/templates/main/lang/ru/header.php"), `template lang files are indexed for phrases: ${paths.join(", ")}`);
  const phrases = await searchBitrixFeatures(dbFile, { featureType: "lang_phrase", query: "TITLE" });
  assert.deepEqual(phrases.map((phrase) => [phrase.name, phrase.detail?.lang, phrase.detail?.text]), [["TITLE", "ru", "X"]]);

  const core = await buildIndex({ root, kind: "bitrix", dbFile, patterns: ["bitrix/modules/**/*.php"], force: true });
  const corePaths = core.files.map((file) => file.relativePath.replace(/\\/g, "/"));
  assert.ok(corePaths.includes("bitrix/modules/main/include.php"));
  assert.ok(!corePaths.some((relativePath) => relativePath.includes("/lang/")), `core lang/ stays excluded: ${corePaths.join(", ")}`);
});

test("template scope includes lang/ when includeLang is set", async () => {
  const root = await makeTemplateFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-lang-on-db-"));

  const manifest = await buildIndex({ root, kind: "template", dbFile: sqlitePath(dataDir), includeLang: true, force: true });
  const paths = manifest.files.map((file) => file.relativePath.replace(/\\/g, "/"));

  assert.ok(paths.some((relativePath) => relativePath.includes("/lang/")), `lang/ should be indexed with includeLang: ${paths.join(", ")}`);
});
