import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { sqlitePath } from "../src/config/paths.js";
import { readIndexFromSqlite } from "../src/indexer/sqliteStore.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");
const tsxLoaderUrl = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

async function makeBitrixFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-bitrix-"));
  const files: Record<string, string> = {
    "bitrix/modules/main/lib/user.php": "<?php\nclass CUser {}\n",
    "bitrix/modules/main/lang/ru/lib/user.php": "<?php\n$MESS['X']='y';\n",
    "bitrix/modules/iblock/lib/element.php": "<?php\nclass CIBlockElement {}\n",
    "bitrix/modules/sale/lib/order.php": "<?php\nclass Order {}\n",
    "bitrix/admin/menu.php": "<?php\nfunction admin_menu(){}\n",
    "bitrix/js/main/core.js": "export function coreFn(){}\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
  return root;
}

function runCli(args: string[], dataDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...args], {
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir }
  });
}

test("index-bitrix --plan reports counts without writing an index", async () => {
  const root = await makeBitrixFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-plan-"));

  const { stdout } = await runCli(["index-bitrix", root, "--plan", "--modules=main,iblock"], dataDir);

  assert.match(stdout, /Bitrix indexing plan/);
  assert.match(stdout, /Modules: main, iblock/);
  assert.match(stdout, /Files queued:/);

  // --plan must not write the index.
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "bitrix");
  assert.equal(manifest, undefined, "plan should not persist a bitrix index");
});

test("index-bitrix --modules indexes only the selected modules and skips lang", async () => {
  const root = await makeBitrixFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-modules-"));

  await runCli(["index-bitrix", root, "--modules=main,iblock"], dataDir);

  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "bitrix");
  const paths = (manifest?.files ?? []).map((file) => file.relativePath.replace(/\\/g, "/"));

  assert.ok(paths.some((p) => p === "bitrix/modules/main/lib/user.php"), `expected main: ${paths.join(", ")}`);
  assert.ok(paths.some((p) => p === "bitrix/modules/iblock/lib/element.php"), `expected iblock: ${paths.join(", ")}`);
  assert.ok(!paths.some((p) => p.startsWith("bitrix/modules/sale/")), `sale must be excluded: ${paths.join(", ")}`);
  assert.ok(!paths.some((p) => p.includes("/lang/")), `lang must be excluded: ${paths.join(", ")}`);
  // admin/js still part of the curated core.
  assert.ok(paths.some((p) => p === "bitrix/admin/menu.php"), `expected admin: ${paths.join(", ")}`);
  assert.ok(paths.some((p) => p === "bitrix/js/main/core.js"), `expected js: ${paths.join(", ")}`);
});

test("index-bitrix warns about unknown modules but proceeds when at least one exists", async () => {
  const root = await makeBitrixFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-unknown-"));

  const { stderr } = await runCli(["index-bitrix", root, "--modules=main,nope"], dataDir);
  assert.match(stderr, /module "nope" was requested but not found/);

  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "bitrix");
  assert.ok((manifest?.files ?? []).some((file) => file.relativePath.replace(/\\/g, "/") === "bitrix/modules/main/lib/user.php"));
});
