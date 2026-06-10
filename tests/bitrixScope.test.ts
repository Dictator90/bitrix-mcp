import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { resolveBitrixIndex } from "../src/indexer/bitrixModules.js";
import { sqlitePath } from "../src/config/paths.js";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

async function makeRoots(): Promise<{ root: string; dataDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-scope-src-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-scope-db-"));
  return { root, dataDir };
}

test("project scope does not crawl the bitrix/ core tree", async () => {
  const { root, dataDir } = await makeRoots();
  await write(root, "index.php", "<?php\nfunction project_fn(): void {}\n");
  await write(root, "local/php_interface/init.php", "<?php\nfunction project_init(): void {}\n");
  await write(root, "bitrix/admin/menu.php", "<?php\nfunction admin_menu(): void {}\n");
  await write(root, "bitrix/wizards/w.php", "<?php\nfunction wizard_fn(): void {}\n");
  await write(root, "bitrix/js/main/core.js", "export function coreFn() {}\n");

  const manifest = await buildIndex({ root, kind: "project", dbFile: sqlitePath(dataDir), force: true });
  const paths = manifest.files.map((file) => file.relativePath).sort();

  assert.ok(paths.includes("index.php"), `project should index its own code: ${paths.join(", ")}`);
  assert.ok(paths.includes("local/php_interface/init.php"), `project should index php_interface: ${paths.join(", ")}`);
  assert.ok(
    paths.every((relativePath) => !relativePath.replace(/\\/g, "/").startsWith("bitrix/")),
    `project must not index any bitrix/ core file, got: ${paths.join(", ")}`
  );
});

test("bitrix core scope indexes modules/admin/tools/js but excludes lang and install", async () => {
  const { root, dataDir } = await makeRoots();
  await write(root, "bitrix/modules/main/lib/user.php", "<?php\nclass CUser {}\n");
  await write(root, "bitrix/modules/main/lang/ru/lib/user.php", "<?php\n$MESS['X'] = 'y';\n");
  await write(root, "bitrix/modules/main/install/index.php", "<?php\nclass main_install {}\n");
  await write(root, "bitrix/admin/menu.php", "<?php\nfunction admin_menu(): void {}\n");
  await write(root, "bitrix/tools/upload.php", "<?php\nfunction tool_upload(): void {}\n");
  await write(root, "bitrix/js/main/core.js", "export function coreFn() {}\n");

  const bitrix = resolveBitrixIndex({ modules: "all" });
  const manifest = await buildIndex({ root, kind: "bitrix", dbFile: sqlitePath(dataDir), patterns: bitrix.patterns, ignores: bitrix.ignores, force: true });
  const paths = manifest.files.map((file) => file.relativePath.replace(/\\/g, "/")).sort();

  assert.ok(paths.includes("bitrix/modules/main/lib/user.php"), `expected module code: ${paths.join(", ")}`);
  assert.ok(paths.includes("bitrix/admin/menu.php"), `expected admin: ${paths.join(", ")}`);
  assert.ok(paths.includes("bitrix/tools/upload.php"), `expected tools: ${paths.join(", ")}`);
  assert.ok(paths.includes("bitrix/js/main/core.js"), `expected js: ${paths.join(", ")}`);

  assert.ok(
    !paths.some((relativePath) => relativePath.includes("/lang/")),
    `lang files must be excluded by default: ${paths.join(", ")}`
  );
  assert.ok(
    !paths.some((relativePath) => relativePath.includes("/install/")),
    `install files must be excluded: ${paths.join(", ")}`
  );
});
