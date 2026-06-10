import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");
const tsxLoaderPath = path.resolve("node_modules/tsx/dist/loader.mjs");
const tsxLoaderUrl = pathToFileURL(tsxLoaderPath).href;
const fixtureRoot = path.resolve("tests/fixtures/project");

async function runCli(args: string[], dataDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...args], {
    cwd: fixtureRoot,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir, NO_COLOR: "" }
  });
}

test("index-template --compact writes compact progress to stderr and keeps stdout clean", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-compact-"));
  const { stdout, stderr } = await runCli(["index-template", "--compact"], dataDir);

  // stderr carries the compact progress: scope label + completion marks.
  assert.match(stderr, /template/, `stderr should show the scope label: ${JSON.stringify(stderr)}`);
  assert.match(stderr, /✓|done|\./, `stderr should show progress marks: ${JSON.stringify(stderr)}`);

  // stdout carries only the existing command result, never progress marks.
  assert.match(stdout, /Indexed \d+ template files into/);
  assert.ok(!stdout.includes("✓"), `stdout must not contain progress checkmarks: ${JSON.stringify(stdout)}`);
});

test("index-template --no-progress emits no progress on stderr", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-noprogress-"));
  const { stdout, stderr } = await runCli(["index-template", "--no-progress"], dataDir);

  assert.ok(!stderr.includes("✓"), `stderr should be free of progress: ${JSON.stringify(stderr)}`);
  assert.ok(!stderr.includes("Parse files"), `stderr should be free of progress: ${JSON.stringify(stderr)}`);
  assert.match(stdout, /Indexed \d+ template files into/);
});

test("index-template --json-progress emits JSON Lines on stderr, not stdout", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-jsonprogress-"));
  const { stdout, stderr } = await runCli(["index-template", "--json-progress"], dataDir);

  const lines = stderr.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "expected JSON progress lines on stderr");
  const parsed = lines.map((line) => JSON.parse(line));
  assert.ok(parsed.some((event) => event.phase === "discover"));
  assert.ok(parsed.every((event) => typeof event.scope === "string"));
  assert.ok(!stdout.includes("{\"phase\""), "stdout must not carry JSON progress");
});

test("serve keeps stdout free of progress text (MCP stdio safety)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-serve-"));
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl, cliPath, "serve"], {
    cwd: fixtureRoot,
    env: { ...process.env, BITRIX_MCP_DATA_DIR: dataDir }
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "progress-test", version: "0.0.0" }
    }
  };
  child.stdin.write(`${JSON.stringify(initialize)}\n`);

  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));

  // Every stdout line must be JSON-RPC, never human progress text.
  assert.ok(!stdout.includes("✓"), `serve stdout must not contain checkmarks: ${JSON.stringify(stdout)}`);
  assert.ok(!stdout.includes("Parse files"), `serve stdout must not contain progress: ${JSON.stringify(stdout)}`);
  for (const line of stdout.split("\n").filter((entry) => entry.trim().length > 0)) {
    assert.doesNotThrow(() => JSON.parse(line), `serve stdout line is not valid JSON-RPC: ${JSON.stringify(line)}`);
  }
});
