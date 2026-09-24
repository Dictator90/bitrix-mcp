import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { applyClean, formatCleanPlan, planClean } from "../src/indexer/clean.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");
const tsxLoaderUrl = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

async function makeDataDir(): Promise<{ root: string; dataDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-clean-"));
  const dataDir = path.join(root, ".bitrix-mcp");
  const files = [
    "bitrix-mcp.sqlite",
    "bitrix-mcp.sqlite-wal",
    "bitrix-mcp.sqlite-shm",
    "project-index.json",
    "template-index.json",
    "benchmark.json",
    "benchmark.md",
    "skills/bitrix-mcp/SKILL.md",
    "rules/bitrix-mcp.md",
    "docs-sources/framework-docs/README.md",
    "notes.txt"
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dataDir, file)), { recursive: true });
    await fs.writeFile(path.join(dataDir, file), "x".repeat(10));
  }
  await fs.writeFile(path.join(root, "bitrix-mcp.sqlite"), "outside");
  return { root, dataDir };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

test("planClean lists index data only and keeps docs checkouts unless all is set", async () => {
  const { dataDir } = await makeDataDir();
  const names = (await planClean(dataDir)).map((target) => path.relative(dataDir, target.path).replace(/\\/g, "/"));
  assert.deepEqual(names, [
    "bitrix-mcp.sqlite",
    "bitrix-mcp.sqlite-wal",
    "bitrix-mcp.sqlite-shm",
    "project-index.json",
    "template-index.json",
    "benchmark.json",
    "benchmark.md"
  ]);
  const all = await planClean(dataDir, { all: true });
  assert.equal(all.at(-1)?.path, path.join(dataDir, "docs-sources"));
  assert.equal(all.at(-1)?.kind, "directory");
  assert.equal(all.at(-1)?.bytes, 10);
  assert.match(formatCleanPlan(dataDir, all, { mode: "dry-run", all: true }), /Dry run: would remove 8 items \(80 B\)/);
  assert.deepEqual(await planClean(path.join(dataDir, "missing")), []);
});

test("applyClean removes planned targets and nothing outside them", async () => {
  const { root, dataDir } = await makeDataDir();
  const failures = await applyClean(dataDir, await planClean(dataDir, { all: true }));
  assert.deepEqual(failures, []);
  assert.equal(await exists(path.join(dataDir, "bitrix-mcp.sqlite")), false);
  assert.equal(await exists(path.join(dataDir, "benchmark.md")), false);
  assert.equal(await exists(path.join(dataDir, "docs-sources")), false);
  assert.equal(await exists(path.join(dataDir, "skills/bitrix-mcp/SKILL.md")), true);
  assert.equal(await exists(path.join(dataDir, "rules/bitrix-mcp.md")), true);
  assert.equal(await exists(path.join(dataDir, "notes.txt")), true);
  assert.equal(await exists(path.join(root, "bitrix-mcp.sqlite")), true);

  const outside = { path: path.join(root, "bitrix-mcp.sqlite"), kind: "file" as const, bytes: 7, description: "forged" };
  const refused = await applyClean(dataDir, [outside]);
  assert.equal(refused.length, 1);
  assert.equal(await exists(outside.path), true);
});

test("cli clean supports --dry-run, requires --yes without a terminal, and removes with --yes", async () => {
  const { root, dataDir } = await makeDataDir();
  const run = (args: string[]) => execFileAsync(process.execPath, ["--import", tsxLoaderUrl, cliPath, "clean", ...args], {
    cwd: root,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir }
  });

  const dryRun = await run(["--dry-run"]);
  assert.match(dryRun.stdout, /Dry run: would remove 7 items/);
  assert.match(dryRun.stdout, /Kept: docs-sources\//);
  assert.equal(await exists(path.join(dataDir, "bitrix-mcp.sqlite")), true);

  await assert.rejects(run([]), (error: { code?: number; stderr?: string }) => error.code === 2 && /--yes/.test(error.stderr ?? ""));
  assert.equal(await exists(path.join(dataDir, "bitrix-mcp.sqlite")), true);

  const removed = await run(["--yes"]);
  assert.match(removed.stdout, /Removed 7 items/);
  assert.equal(await exists(path.join(dataDir, "bitrix-mcp.sqlite")), false);
  assert.equal(await exists(path.join(dataDir, "docs-sources/framework-docs/README.md")), true);

  const nothing = await run(["--yes"]);
  assert.match(nothing.stdout, /Nothing to clean/);
});
