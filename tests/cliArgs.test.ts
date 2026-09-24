import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { COMMANDS, integerOption, listOption, parseCli, UsageError } from "../src/cli/args.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");
const tsxLoaderUrl = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

function commandOf(argv: string[]) {
  const parsed = parseCli(argv);
  assert.equal(parsed.kind, "command");
  return parsed as Extract<ReturnType<typeof parseCli>, { kind: "command" }>;
}

test("parseCli: global flags, usage, and version only before the command", () => {
  assert.deepEqual(parseCli([]), { kind: "usage" });
  assert.deepEqual(parseCli(["--help"]), { kind: "usage" });
  assert.deepEqual(parseCli(["-h"]), { kind: "usage" });
  assert.deepEqual(parseCli(["--version"]), { kind: "version" });
  assert.deepEqual(parseCli(["-v"]), { kind: "version" });
  // -v after a command is not the global flag.
  assert.throws(() => parseCli(["status", "-v"]), UsageError);
  assert.throws(() => parseCli(["--bogus"]), /Unknown option: --bogus/);
  assert.throws(() => parseCli(["nope"]), /Unknown command: nope/);
});

test("parseCli: <command> --help / -h returns help without running the command", () => {
  for (const command of Object.keys(COMMANDS)) {
    assert.deepEqual(parseCli([command, "--help"]), { kind: "help", command });
    assert.deepEqual(parseCli([command, "-h"]), { kind: "help", command });
  }
  // Help wins even when other arguments are invalid.
  assert.deepEqual(parseCli(["index-code", "--bogus", "--help"]), { kind: "help", command: "index-code" });
  assert.deepEqual(parseCli(["--help", "init"]), { kind: "help", command: "init" });
});

test("parseCli: value options accept both --name value and --name=value", () => {
  const spaced = commandOf(["index-bitrix", "/root", "--modules", "main,iblock", "--plan"]);
  assert.equal(spaced.values.modules, "main,iblock");
  assert.deepEqual(spaced.positionals, ["/root"]);

  const equals = commandOf(["index-bitrix", "--modules=main,iblock"]);
  assert.equal(equals.values.modules, "main,iblock");
  assert.deepEqual(equals.positionals, []);

  const init = commandOf(["init", "--agent", "cursor", "--agent=codex,claude", "-y", "--php-bin", "/usr/bin/php", "--no-hooks"]);
  assert.deepEqual(listOption(init.values, "agent"), ["cursor", "codex", "claude"]);
  assert.equal(init.values.yes, true);
  assert.equal(init.values["php-bin"], "/usr/bin/php");
  assert.equal(init.values["no-hooks"], true);

  const detect = commandOf(["detect-changes", "--base", "main", "--depth=3", "--max-files", "10", "--json"]);
  assert.equal(detect.values.base, "main");
  assert.equal(integerOption(detect.values, "depth"), 3);
  assert.equal(integerOption(detect.values, "max-files", 1), 10);
});

test("parseCli: keeps every documented flag working", () => {
  const cases: string[][] = [
    ["init", "--all-agents", "--no-index", "--no-docs", "--no-official-docs", "--no-serve", "--serve", "--no-db", "--db-allow-write", "--tinker", "--yes"],
    ["configure", "--agent", "cursor", "--no-hooks"],
    ["uninstall", "--agent", "cursor", "--all-agents", "--dry-run"],
    ["config", "--json"],
    ["doctor", "--json", "--verbose"],
    ["index-all", "--force", "--no-bitrix", "--bitrix-modules=main", "--full", "--include-lang", "--install", "--progress", "--compact"],
    ["index-code", "--force", "--modules", "main", "--exclude-lang", "--no-progress", "--json-progress"],
    ["index-project", "root", "--force", "--include-lang"],
    ["index-template", "local/templates/x", "--force"],
    ["index-install", "--force"],
    ["index-docs", "--force", "--embeddings"],
    ["graph-neighbors", "class", "CUser", "--direction", "in", "--relation-type", "extends", "--depth", "2", "--limit", "5", "--full", "--json"],
    ["impact-radius", "a.php", "b.php", "--base", "HEAD~2", "--relation-types", "a,b", "--no-symbols", "--no-risk", "--limit=3", "--json"],
    ["detect-changes", "--kind", "php", "--include-source", "--no-relations", "--no-impact", "--no-risk", "--max-items", "4", "--full"],
    ["benchmark", "--force"],
    ["serve", "--debug"]
  ];
  for (const argv of cases) {
    assert.doesNotThrow(() => commandOf(argv), `rejected: ${argv.join(" ")}`);
  }
});

test("parseCli: unknown options, extra positionals, and missing values are usage errors", () => {
  assert.throws(() => parseCli(["index-code", "--bogus"]), /Unknown option for "index-code": --bogus/);
  assert.throws(() => parseCli(["status", "--force"]), /Unknown option for "status": --force/);
  assert.throws(() => parseCli(["index-code", "extra"]), /Unexpected argument for "index-code": extra/);
  assert.throws(() => parseCli(["init", "--agent"]), UsageError);
  assert.throws(() => parseCli(["init", "--php-bin="]), /--php-bin requires a value/);
});

test("integerOption validates numeric options", () => {
  assert.equal(integerOption({}, "depth"), undefined);
  assert.equal(integerOption({ depth: "0" }, "depth"), 0);
  assert.throws(() => integerOption({ depth: "abc" }, "depth"), /--depth must be an integer >= 0, got "abc"/);
  assert.throws(() => integerOption({ depth: "1.5" }, "depth"), UsageError);
  assert.throws(() => integerOption({ limit: "0" }, "limit", 1), /--limit must be an integer >= 1/);
});

async function isolatedDirs(): Promise<{ cwd: string; home: string; env: NodeJS.ProcessEnv }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-args-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cli-args-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BITRIX_MCP_HOME_DIR: home };
  delete env.BITRIX_MCP_DATA_DIR;
  delete env.BITRIX_MCP_WORKSPACE;
  delete env.BITRIX_ROOT;
  return { cwd, home, env };
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...args], { cwd, env });
}

test("cli index-code --help prints help and does not index", async () => {
  const { cwd, home, env } = await isolatedDirs();
  await fs.writeFile(path.join(cwd, "index.php"), "<?php\nfunction demo(): void {}\n", "utf8");

  const { stdout } = await runCli(["index-code", "--help"], cwd, env);

  assert.match(stdout, /Usage: bitrix-mcp index-code/);
  assert.match(stdout, /--modules/);
  assert.deepEqual(await fs.readdir(cwd), ["index.php"], "no .bitrix-mcp data dir is created");
  assert.deepEqual(await fs.readdir(home), []);
});

test("cli init --help prints help and writes no configs", async () => {
  const { cwd, home, env } = await isolatedDirs();

  for (const args of [["init", "--help"], ["init", "-h", "--agent", "cursor"], ["configure", "--help"], ["uninstall", "--help"]]) {
    const { stdout } = await runCli(args, cwd, env);
    assert.match(stdout, new RegExp(`Usage: bitrix-mcp ${args[0]}`));
  }
  assert.deepEqual(await fs.readdir(cwd), [], "no .bitrix-mcp or client configs are created");
  assert.deepEqual(await fs.readdir(home), []);
});

test("cli exits non-zero with a message on unknown options and bad numbers; --debug adds the stack", async () => {
  const { cwd, env } = await isolatedDirs();

  await assert.rejects(runCli(["index-code", "--bogus"], cwd, env), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /Unknown option for "index-code": --bogus/);
    assert.doesNotMatch(error.stderr, /\n\s+at /);
    return true;
  });
  await assert.rejects(runCli(["graph-neighbors", "class", "CUser", "--depth", "deep"], cwd, env), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--depth must be an integer >= 0, got "deep"/);
    return true;
  });
  await assert.rejects(runCli(["--debug", "index-code", "--bogus"], cwd, env), (error: { stderr: string }) => {
    assert.match(error.stderr, /UsageError: Unknown option/);
    assert.match(error.stderr, /\n\s+at /);
    return true;
  });
  assert.deepEqual(await fs.readdir(cwd), []);
});

test("cli configure --yes reports the chosen agent and uninstall --dry-run/uninstall revert it", async () => {
  const { cwd, home, env } = await isolatedDirs();

  const configured = await runCli(["configure", "--yes"], cwd, env);
  assert.match(configured.stderr, /configuring the default agent: Cursor/);
  await fs.access(path.join(cwd, ".cursor", "mcp.json"));

  const dryRun = await runCli(["uninstall", "--agent", "cursor", "--dry-run"], cwd, env);
  assert.match(dryRun.stdout, /Dry run/);
  assert.match(dryRun.stdout, /\.cursor[\\/]mcp\.json/);
  await fs.access(path.join(cwd, ".cursor", "mcp.json"));

  const removed = await runCli(["uninstall", "--agent=cursor"], cwd, env);
  assert.match(removed.stdout, /Removed bitrix-mcp configuration/);
  await assert.rejects(fs.access(path.join(cwd, ".cursor", "mcp.json")));
  await assert.rejects(fs.access(path.join(cwd, ".cursor", "rules", "bitrix-mcp.mdc")));
  assert.deepEqual(await fs.readdir(home), []);
});

test("parseCli: watch, clean, and init/configure --dry-run options", () => {
  const watch = commandOf(["watch", "--no-bitrix", "--docs", "--debounce", "250", "--json", "--modules=main"]);
  assert.equal(watch.values["no-bitrix"], true);
  assert.equal(watch.values.docs, true);
  assert.equal(integerOption(watch.values, "debounce"), 250);
  assert.equal(watch.values.modules, "main");
  assert.throws(() => parseCli(["watch", "--dry-run"]), /Unknown option for "watch": --dry-run/);

  const clean = commandOf(["clean", "--dry-run", "-y", "--all"]);
  assert.deepEqual([clean.values["dry-run"], clean.values.yes, clean.values.all], [true, true, true]);
  assert.throws(() => parseCli(["clean", "--force"]), UsageError);

  assert.equal(commandOf(["configure", "--agent", "cursor", "--dry-run"]).values["dry-run"], true);
  assert.equal(commandOf(["init", "--dry-run"]).values["dry-run"], true);
});
