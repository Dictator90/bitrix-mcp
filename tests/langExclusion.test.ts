import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { sqlitePath } from "../src/config/paths.js";

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

test("template scope excludes lang/ directories by default", async () => {
  const root = await makeTemplateFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-lang-db-"));

  const manifest = await buildIndex({ root, kind: "template", dbFile: sqlitePath(dataDir), force: true });
  const paths = manifest.files.map((file) => file.relativePath.replace(/\\/g, "/"));

  assert.ok(paths.includes("local/templates/main/header.php"), `template code should be indexed: ${paths.join(", ")}`);
  assert.ok(
    !paths.some((relativePath) => relativePath.includes("/lang/")),
    `lang/ files must be excluded by default across all scopes: ${paths.join(", ")}`
  );
});

test("template scope includes lang/ when includeLang is set", async () => {
  const root = await makeTemplateFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-lang-on-db-"));

  const manifest = await buildIndex({ root, kind: "template", dbFile: sqlitePath(dataDir), includeLang: true, force: true });
  const paths = manifest.files.map((file) => file.relativePath.replace(/\\/g, "/"));

  assert.ok(paths.some((relativePath) => relativePath.includes("/lang/")), `lang/ should be indexed with includeLang: ${paths.join(", ")}`);
});
