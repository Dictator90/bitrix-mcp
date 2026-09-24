import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { replaceTomlTable } from "../src/init/configFiles.js";
import { configureAgents, serverInvocation, upsertCodexToml, writeAgentGuidance, writeMcpServersConfig, type InitContext } from "../src/init/init.js";
import { uninstall } from "../src/init/uninstall.js";

async function makeContext(prefix: string, overrides: Partial<InitContext> = {}): Promise<InitContext> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: true,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php",
    homeDir: path.join(projectRoot, "fake-home"),
    ...overrides
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("writeMcpServersConfig keeps JSONC comments, trailing commas, and '//' or '/**/' inside strings", async () => {
  const context = await makeContext("bitrix-mcp-jsonc-");
  const configPath = path.join(context.projectRoot, ".claude-like.json");
  const source = [
    "{",
    "  // user comment",
    "  \"permissions\": { \"allow\": [\"Read(src/**/*.ts)\", \"Bash(npm run *)\",], },",
    "  \"homepage\": \"https://example.com//path\", /* block comment */",
    "  \"mcpServers\": {",
    "    \"other\": { \"command\": \"other\", },",
    "  },",
    "}",
    ""
  ].join("\n");
  await fs.writeFile(configPath, source, "utf8");

  const result = await writeMcpServersConfig(configPath, context);
  assert.equal(result.outcome, "updated");

  const text = await fs.readFile(configPath, "utf8");
  // Regression: the old regex comment stripper turned this into "Read(src*.ts)".
  assert.match(text, /"Read\(src\/\*\*\/\*\.ts\)"/);
  assert.match(text, /\/\/ user comment/);
  assert.match(text, /\/\* block comment \*\//);
  assert.match(text, /"https:\/\/example\.com\/\/path"/);

  const errors: unknown[] = [];
  const value = parse(text, errors as never, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(value.permissions.allow, ["Read(src/**/*.ts)", "Bash(npm run *)"]);
  assert.equal(value.mcpServers.other.command, "other");
  assert.equal(value.mcpServers["bitrix-mcp"].command, serverInvocation().command);

  // One-time backup of the original content.
  assert.equal(await fs.readFile(`${configPath}.bak`, "utf8"), source);
});

test("writeMcpServersConfig aborts on unparsable JSON, names the file, and does not overwrite it", async () => {
  const context = await makeContext("bitrix-mcp-jsonc-broken-");
  const configPath = path.join(context.projectRoot, "mcp.json");
  const broken = "{ \"mcpServers\": { \"x\": { \"command\": } }";
  await fs.writeFile(configPath, broken, "utf8");

  await assert.rejects(writeMcpServersConfig(configPath, context), (error: Error) => {
    assert.ok(error.message.includes(configPath), error.message);
    assert.match(error.message, /Cannot parse/);
    return true;
  });
  assert.equal(await fs.readFile(configPath, "utf8"), broken);
  assert.equal(await exists(`${configPath}.bak`), false);
});

test("writeMcpServersConfig skips unchanged files and keeps the first backup", async () => {
  const context = await makeContext("bitrix-mcp-backup-");
  const configPath = path.join(context.projectRoot, "mcp.json");
  const original = "{\n  \"mcpServers\": {}\n}\n";
  await fs.writeFile(configPath, original, "utf8");

  assert.equal((await writeMcpServersConfig(configPath, context)).outcome, "updated");
  const afterFirst = await fs.readFile(configPath, "utf8");
  assert.equal((await writeMcpServersConfig(configPath, context)).outcome, "unchanged");
  assert.equal(await fs.readFile(configPath, "utf8"), afterFirst);

  await writeMcpServersConfig(configPath, { ...context, dbAllowWrite: true });
  assert.equal(await fs.readFile(`${configPath}.bak`, "utf8"), original, "backup keeps the pre-bitrix-mcp content");

  const fresh = path.join(context.projectRoot, "new", "mcp.json");
  assert.equal((await writeMcpServersConfig(fresh, context)).outcome, "created");
  assert.equal(await exists(`${fresh}.bak`), false);
});

test("writeMcpServersConfig merges into an existing bitrix-mcp entry and keeps user keys", async () => {
  const context = await makeContext("bitrix-mcp-merge-");
  const configPath = path.join(context.projectRoot, "cline_mcp_settings.json");
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: {
      "bitrix-mcp": {
        command: "old",
        args: ["old"],
        disabled: true,
        timeout: 120,
        alwaysAllow: ["bitrix_docs_search"],
        env: {
          BITRIX_MCP_DOCS_PATHS: "/extra/docs",
          BITRIX_MCP_WORKSPACE: "/old/root",
          BITRIX_MCP_PHP_BIN: "/stale/php"
        }
      }
    }
  }, null, 2), "utf8");

  await writeMcpServersConfig(configPath, context, { defaults: { alwaysAllow: [], disabled: false } });

  const entry = JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers["bitrix-mcp"];
  assert.equal(entry.command, serverInvocation().command);
  assert.deepEqual(entry.args, serverInvocation().args);
  assert.equal(entry.disabled, true);
  assert.equal(entry.timeout, 120);
  assert.deepEqual(entry.alwaysAllow, ["bitrix_docs_search"]);
  assert.equal(entry.env.BITRIX_MCP_DOCS_PATHS, "/extra/docs");
  assert.equal(entry.env.BITRIX_MCP_WORKSPACE, context.projectRoot);
  assert.equal(entry.env.BITRIX_MCP_DB_ENABLED, "1");
  // Managed keys that no longer apply (tinker off) are removed.
  assert.equal("BITRIX_MCP_PHP_BIN" in entry.env, false);
});

test("writeMcpServersConfig adds Cline-style defaults only for a new entry", async () => {
  const context = await makeContext("bitrix-mcp-merge-new-");
  const configPath = path.join(context.projectRoot, "mcp.json");
  await writeMcpServersConfig(configPath, context, { defaults: { alwaysAllow: [], disabled: false } });
  const entry = JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers["bitrix-mcp"];
  assert.deepEqual(entry.alwaysAllow, []);
  assert.equal(entry.disabled, false);
});

test("writeAgentGuidance with hooks: false writes no hook files", async () => {
  const context = await makeContext("bitrix-mcp-no-hooks-");
  for (const agent of ["claude-code", "cursor", "gemini-cli", "codex", "vscode", "cline"] as const) {
    const results = await writeAgentGuidance(agent, context, { hooks: false });
    assert.ok(!results.some((result) => /hooks/i.test(result.label)), `${agent} wrote hooks`);
  }
  assert.equal(await exists(path.join(context.projectRoot, ".claude", "settings.json")), false);
  assert.equal(await exists(path.join(context.projectRoot, ".cursor", "hooks.json")), false);
  assert.equal(await exists(path.join(context.projectRoot, ".codex", "hooks.json")), false);
  assert.equal(await exists(path.join(context.projectRoot, ".github", "hooks", "bitrix-mcp.json")), false);
  assert.equal(await exists(path.join(context.projectRoot, ".clinerules", "hooks", "UserPromptSubmit")), false);
});

test("writeAgentGuidance leaves user-owned Cline and Copilot hook files alone", async () => {
  const context = await makeContext("bitrix-mcp-user-hooks-");
  const clineHook = path.join(context.projectRoot, ".clinerules", "hooks", "UserPromptSubmit");
  const copilotHook = path.join(context.projectRoot, ".github", "hooks", "bitrix-mcp.json");
  await fs.mkdir(path.dirname(clineHook), { recursive: true });
  await fs.mkdir(path.dirname(copilotHook), { recursive: true });
  await fs.writeFile(clineHook, "#!/bin/sh\necho mine\n", "utf8");
  await fs.writeFile(copilotHook, "{\"hooks\":{}}\n", "utf8");

  const cline = await writeAgentGuidance("cline", context);
  const copilot = await writeAgentGuidance("vscode", context);

  assert.match(cline.find((result) => result.label === "Cline hooks")?.warning ?? "", /not created by bitrix-mcp/);
  assert.match(copilot.find((result) => result.label === "Copilot hooks")?.warning ?? "", /not created by bitrix-mcp/);
  assert.equal(await fs.readFile(clineHook, "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(await fs.readFile(copilotHook, "utf8"), "{\"hooks\":{}}\n");
});

test("upsertCodexToml handles quoted keys, trailing comments, [[arrays]], and stale env sub-tables", async () => {
  const context = await makeContext("bitrix-mcp-toml-");
  const source = [
    "model = \"o3\"",
    "",
    "[mcp_servers.\"bitrix-mcp\"] # managed by bitrix-mcp",
    "command = \"old\"",
    "args = [\"old\"]",
    "",
    "[mcp_servers.bitrix-mcp.env]",
    "BITRIX_MCP_WORKSPACE = \"/old\"",
    "",
    "# comment that belongs to the next table",
    "[[profiles.list]]",
    "name = \"a\"",
    "",
    "[mcp_servers.other]",
    "command = \"other\"",
    ""
  ].join("\n");

  const next = upsertCodexToml(source, context);

  assert.equal((next.match(/^\[mcp_servers\.bitrix-mcp\]$/gm) ?? []).length, 1);
  assert.doesNotMatch(next, /mcp_servers\."bitrix-mcp"/);
  assert.doesNotMatch(next, /\[mcp_servers\.bitrix-mcp\.env\]/);
  assert.doesNotMatch(next, /"\/old"/);
  assert.match(next, /^model = "o3"$/m);
  assert.match(next, /# comment that belongs to the next table\n\[\[profiles\.list\]\]\nname = "a"/);
  assert.match(next, /\[mcp_servers\.other\]\ncommand = "other"/);
  assert.ok(next.indexOf("[mcp_servers.bitrix-mcp]") < next.indexOf("[[profiles.list]]"), "block is replaced in place");
  assert.ok(next.includes(`BITRIX_MCP_WORKSPACE = ${JSON.stringify(context.projectRoot)}`));

  // Idempotent.
  assert.equal(upsertCodexToml(next, context), next);
});

test("replaceTomlTable stops at an [[array]] header and ignores headers inside multi-line strings", () => {
  const source = [
    "[mcp_servers.bitrix-mcp]",
    "command = \"x\"",
    "[[mcp_servers.other.tools]]",
    "name = \"t\"",
    "[notes]",
    "text = \"\"\"",
    "[mcp_servers.bitrix-mcp]",
    "\"\"\"",
    ""
  ].join("\n");
  const next = replaceTomlTable(source, ["mcp_servers", "bitrix-mcp"], undefined);
  assert.equal(next, [
    "[[mcp_servers.other.tools]]",
    "name = \"t\"",
    "[notes]",
    "text = \"\"\"",
    "[mcp_servers.bitrix-mcp]",
    "\"\"\"",
    ""
  ].join("\n"));
});

async function withCwdAndHome<T>(projectRoot: string, homeDir: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const previousHome = process.env.BITRIX_MCP_HOME_DIR;
  process.chdir(projectRoot);
  process.env.BITRIX_MCP_HOME_DIR = homeDir;
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.BITRIX_MCP_HOME_DIR;
    else process.env.BITRIX_MCP_HOME_DIR = previousHome;
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    result[path.relative(root, full).replace(/\\/g, "/")] = await fs.readFile(full, "utf8");
  }
  return result;
}

test("uninstall removes everything configure wrote and keeps user content", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-uninstall-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-uninstall-home-"));

  // Pre-existing user content that must survive.
  await fs.writeFile(path.join(projectRoot, "CLAUDE.md"), "# Team rules\n\nKeep me.\n", "utf8");
  await fs.mkdir(path.join(projectRoot, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".cursor", "mcp.json"), "{\n  // mine\n  \"mcpServers\": { \"other\": { \"command\": \"other\" } }\n}\n", "utf8");
  await fs.mkdir(path.join(projectRoot, ".claude"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read(src/**/*.ts)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2), "utf8");
  await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await fs.writeFile(path.join(homeDir, ".codex", "config.toml"), "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n", "utf8");

  await withCwdAndHome(projectRoot, homeDir, () => configureAgents({ allAgents: true }));

  // Sanity: configure touched project and (fake) home configs.
  assert.match(await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.bitrix-mcp\]/);
  assert.ok(await exists(path.join(homeDir, ".codeium", "windsurf", "mcp_config.json")));
  assert.ok(await exists(path.join(projectRoot, ".claude", "skills", "bitrix-mcp", "SKILL.md")));

  // Dry run changes nothing.
  const beforeProject = await snapshot(projectRoot);
  const beforeHome = await snapshot(homeDir);
  const planned = await uninstall({ projectRoot, homeDir, dryRun: true });
  assert.ok(planned.some((action) => action.action === "delete"));
  assert.deepEqual(await snapshot(projectRoot), beforeProject);
  assert.deepEqual(await snapshot(homeDir), beforeHome);

  await uninstall({ projectRoot, homeDir });

  // User content survives.
  const claudeMd = await fs.readFile(path.join(projectRoot, "CLAUDE.md"), "utf8");
  assert.equal(claudeMd, "# Team rules\n\nKeep me.\n");
  const cursorMcp = await fs.readFile(path.join(projectRoot, ".cursor", "mcp.json"), "utf8");
  assert.match(cursorMcp, /\/\/ mine/);
  assert.match(cursorMcp, /"other"/);
  assert.doesNotMatch(cursorMcp, /bitrix-mcp/);
  const settings = JSON.parse(await fs.readFile(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings, { permissions: { allow: ["Read(src/**/*.ts)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
  const codex = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(codex, /bitrix-mcp/);

  // Everything bitrix-mcp created is gone.
  for (const relative of [
    ".mcp.json",
    ".vscode/mcp.json",
    ".roo/mcp.json",
    ".gemini/settings.json",
    ".continue/mcpServers/bitrix-mcp.json",
    ".cursor/rules/bitrix-mcp.mdc",
    ".cursor/hooks.json",
    ".codex/hooks.json",
    ".github/hooks/bitrix-mcp.json",
    ".github/copilot-instructions.md",
    ".clinerules/hooks/UserPromptSubmit",
    ".clinerules/bitrix-mcp.md",
    ".claude/skills/bitrix-mcp/SKILL.md",
    ".bitrix-mcp/skills/bitrix-mcp/SKILL.md",
    "GEMINI.md",
    "AGENTS.md",
    ".junie/guidelines.md"
  ]) {
    assert.equal(await exists(path.join(projectRoot, relative)), false, `${relative} should be removed`);
  }
  assert.equal(await exists(path.join(projectRoot, ".claude", "skills")), false, "empty skill dirs are cleaned up");
  const windsurf = JSON.parse(await fs.readFile(path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"), "utf8").catch(() => "{}"));
  assert.equal(windsurf.mcpServers?.["bitrix-mcp"], undefined);

  // A second run finds nothing.
  const again = await uninstall({ projectRoot, homeDir });
  assert.equal(again.filter((action) => action.action === "update" || action.action === "delete").length, 0);
});

test("uninstall --agent only touches the selected agent and skips global entries of other workspaces", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-uninstall-agent-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-uninstall-agent-home-"));
  await withCwdAndHome(projectRoot, homeDir, () => configureAgents({ agents: ["cursor", "windsurf"] }));

  const windsurfPath = path.join(homeDir, ".codeium", "windsurf", "mcp_config.json");
  const windsurf = JSON.parse(await fs.readFile(windsurfPath, "utf8"));
  windsurf.mcpServers["bitrix-mcp"].env.BITRIX_MCP_WORKSPACE = "/some/other/project";
  await fs.writeFile(windsurfPath, JSON.stringify(windsurf, null, 2), "utf8");

  const cursorOnly = await uninstall({ projectRoot, homeDir, agents: ["cursor"] });
  assert.ok(cursorOnly.every((action) => !action.path?.includes("windsurf")));
  assert.equal(await exists(path.join(projectRoot, ".cursor", "mcp.json")), false);
  assert.ok(await exists(path.join(projectRoot, ".windsurf", "rules", "bitrix-mcp.md")));
  // Canonical skill is shared and only removed when uninstalling every agent.
  assert.ok(await exists(path.join(projectRoot, ".bitrix-mcp", "skills", "bitrix-mcp", "SKILL.md")));

  const windsurfRun = await uninstall({ projectRoot, homeDir, agents: ["windsurf"] });
  assert.ok(windsurfRun.some((action) => action.action === "skip" && action.path === windsurfPath));
  assert.ok(JSON.parse(await fs.readFile(windsurfPath, "utf8")).mcpServers["bitrix-mcp"]);
  assert.equal(await exists(path.join(projectRoot, ".windsurf", "rules", "bitrix-mcp.md")), false);
});
