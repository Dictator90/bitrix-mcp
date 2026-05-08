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

test("cli help documents embeddings indexing commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "--help"], { cwd: fixtureRoot });

  assert.match(stdout, /index-docs \[--force\] \[--embeddings\]/);
  assert.match(stdout, /index-embeddings/);
});

test("cli config prints resolved runtime paths and MCP config file presence", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-config-"));
  await fs.mkdir(path.join(fixtureRoot, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, ".cursor", "mcp.json"), "{}\n", "utf8");
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "config"], {
      cwd: fixtureRoot,
      env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir, BITRIX_MCP_SEMANTIC_ENABLED: "1" }
    });

    assert.ok(stdout.includes(`workspaceRoot: ${fixtureRoot}`));
    assert.ok(stdout.includes(`dataDir: ${dataDir}`));
    assert.match(stdout, /sqlitePath: .*bitrix-mcp\.sqlite/);
    assert.match(stdout, /semanticEnabled: true/);
    assert.match(stdout, /present Cursor \[project\]: .*\.cursor.*mcp\.json/);
    assert.match(stdout, /MCP config files:/);
  } finally {
    await fs.rm(path.join(fixtureRoot, ".cursor"), { recursive: true, force: true });
  }
});

test("cli config --json emits script-friendly diagnostics", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-config-json-"));
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "config", "--json"], {
    cwd: fixtureRoot,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir, BITRIX_MCP_OFFICIAL_DOCS_ENABLED: "0" }
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.runtime.workspaceRoot, fixtureRoot);
  assert.equal(parsed.runtime.dataDir, dataDir);
  assert.equal(parsed.runtime.sqlitePath, sqlitePath(dataDir));
  assert.deepEqual(parsed.runtime.docsPaths, [path.join(fixtureRoot, "docs")]);
  assert.equal(parsed.runtime.officialDocsEnabled, false);
  assert.ok(parsed.mcpConfigFiles.some((entry: { client: string; path?: string; exists: boolean }) => entry.client === "Claude Code" && entry.path === path.join(fixtureRoot, ".mcp.json") && entry.exists === false));
});

test("cli doctor --json includes checks and config diagnostics", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doctor-json-"));
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "doctor", "--json"], {
    cwd: fixtureRoot,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir }
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.runtime.workspaceRoot, fixtureRoot);
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.checks.some((check: { name: string }) => check.name === "workspace"));
  assert.ok(Array.isArray(parsed.mcpConfigFiles));
});
