import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTextFileIfExists, withDryRun, writeTextIfChanged } from "../src/init/configFiles.js";
import { unifiedDiff } from "../src/init/diff.js";
import { configureAgents, initAndServe } from "../src/init/init.js";

async function captureStderr(task: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await task();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

async function inProject<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    return await task();
  } finally {
    process.chdir(previousCwd);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/")).sort();
}

test("unifiedDiff renders hunks with context, and /dev/null for new files", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
  const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
  assert.equal(unifiedDiff("x.txt", before, after), [
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -2,9 +2,10 @@",
    " b",
    " c",
    " d",
    "-e",
    "+E",
    " f",
    " g",
    " h",
    " i",
    " j",
    "+k"
  ].join("\n"));
  assert.equal(unifiedDiff("new.json", undefined, "{\n}\n"), ["--- /dev/null", "+++ b/new.json", "@@ -0,0 +1,2 @@", "+{", "+}"].join("\n"));
  assert.equal(unifiedDiff("same", "x\n", "x\n"), "");
});

test("withDryRun records writes, never touches disk, and lets later reads see planned content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-dry-run-"));
  const filePath = path.join(dir, "nested", "config.json");
  const { result, writes } = await withDryRun(async () => {
    assert.equal(await writeTextIfChanged(filePath, "one\n"), "created");
    assert.equal(await readTextFileIfExists(filePath), "one\n");
    await writeTextIfChanged(filePath, "two\n");
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(writes, [{ filePath, previous: undefined, next: "two\n", outcome: "created" }]);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("configure --dry-run prints planned files and diffs without writing anything", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-configure-dry-"));
  const existing = `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2)}\n`;
  await fs.writeFile(path.join(projectRoot, ".mcp.json"), existing);
  const before = await listFiles(projectRoot);

  const output = await captureStderr(() => inProject(projectRoot, () => configureAgents({ agents: ["claude-code", "gemini-cli"], dryRun: true })));

  assert.deepEqual(await listFiles(projectRoot), before, "no file is created");
  assert.equal(await fs.readFile(path.join(projectRoot, ".mcp.json"), "utf8"), existing);
  assert.match(output, /Claude Code MCP config would be updated: /);
  assert.match(output, /Dry run: no files were written\. Planned changes:/);
  assert.match(output, /^ {2}update {4}\.mcp\.json$/m);
  assert.match(output, /^ {2}create {4}CLAUDE\.md$/m);
  assert.match(output, /^--- a\/\.mcp\.json$/m);
  assert.match(output, /^\+ {4}"bitrix-mcp": \{$/m);
  assert.match(output, /^ {5}"other": \{$/m, "diff keeps context from the existing file");
  // .gemini/settings.json gets the MCP entry and the hooks: one planned file, combined content.
  assert.equal(output.match(/^ {2}create {4}\.gemini\/settings\.json$/gm)?.length, 1);
  const geminiDiff = output.slice(output.indexOf("+++ b/.gemini/settings.json"));
  assert.match(geminiDiff, /"mcpServers"/);
  assert.match(geminiDiff, /"BeforeAgent"/);
});

test("init --dry-run writes, indexes, and serves nothing", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-init-dry-"));
  let served = false;
  const output = await captureStderr(() => inProject(projectRoot, () => initAndServe(
    { agents: ["cursor"], dryRun: true, serve: true },
    { serveStdio: async () => { served = true; } }
  )));
  assert.equal(served, false);
  assert.deepEqual(await fs.readdir(projectRoot), [], "not even the data directory is created");
  assert.match(output, /^ {2}create {4}\.cursor\/mcp\.json$/m);
  assert.match(output, /Would index code \(project, templates\)/);
  assert.match(output, /Would index documentation/);
  assert.match(output, /Would start the stdio MCP server/);
});
