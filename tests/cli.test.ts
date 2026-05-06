import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sqlitePath } from "../src/config/paths.js";
import { readIndexFromSqlite } from "../src/indexer/sqliteStore.js";
import type { IndexManifest } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");
const fixtureRoot = path.resolve("tests/fixtures/project");

async function runCliIndexTemplate(args: string[] = []): Promise<IndexManifest> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-"));
  await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "index-template", ...args], {
    cwd: fixtureRoot,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir }
  });
  await assert.rejects(fs.readFile(path.join(dataDir, "template-index.json"), "utf8"));
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");
  assert.ok(manifest);
  return manifest;
}

test("cli index-template indexes a relative templatePath from workspace root", async () => {
  const manifest = await runCliIndexTemplate(["local/templates/my_template"]);

  assert.equal(manifest.root, path.join(fixtureRoot, "local/templates/my_template"));
  assert.ok(manifest.files.every((file) => !file.relativePath.startsWith("local/templates")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});

test("cli index-template without an argument indexes standard template locations", async () => {
  const manifest = await runCliIndexTemplate();

  assert.equal(manifest.root, fixtureRoot);
  assert.ok(manifest.files.some((file) => file.relativePath.startsWith("local/templates/")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "template_helper")));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});
