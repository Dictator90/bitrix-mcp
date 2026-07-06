import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqlitePath } from "../src/config/paths.js";
import { AGENT_CHOICES, configureAgents, defaultShouldServe, envConfig, indexIfMissing, initAndServe, parseAgentIds, serverInvocation, writeAgentGuidance, writeMcpServersConfig } from "../src/init/init.js";
import { ensureSqliteStore } from "../src/indexer/sqliteStore.js";

test("envConfig writes per-project MCP paths and detected BITRIX_ROOT", () => {
  const projectRoot = path.join(os.tmpdir(), "bitrix-mcp-project");
  const config = envConfig({
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    bitrixRoot: projectRoot,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  });

  assert.equal(config.BITRIX_MCP_WORKSPACE, projectRoot);
  assert.equal(config.BITRIX_MCP_DATA_DIR, path.join(projectRoot, ".bitrix-mcp"));
  assert.equal(config.BITRIX_MCP_DOCS_DIR, path.join(projectRoot, "docs"));
  assert.equal(config.BITRIX_ROOT, projectRoot);
  assert.equal(config.BITRIX_MCP_SEMANTIC_ENABLED, "0");
});

test("writeMcpServersConfig updates only bitrix-mcp and keeps other MCP servers", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-init-"));
  const configPath = path.join(projectRoot, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          "existing-server": {
            command: "existing",
            args: ["serve"]
          },
          "bitrix-mcp": {
            command: "old-bitrix-mcp",
            args: ["old"]
          }
        },
        unrelatedSetting: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeMcpServersConfig(configPath, {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    bitrixRoot: projectRoot,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  });

  const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(updated.mcpServers["existing-server"], {
    command: "existing",
    args: ["serve"]
  });
  assert.equal(updated.unrelatedSetting, true);
  assert.equal(updated.mcpServers["bitrix-mcp"].command, serverInvocation().command);
  assert.deepEqual(updated.mcpServers["bitrix-mcp"].args, serverInvocation().args);
  assert.equal(updated.mcpServers["bitrix-mcp"].env.BITRIX_MCP_WORKSPACE, projectRoot);
  assert.equal(updated.mcpServers["bitrix-mcp"].env.BITRIX_MCP_DATA_DIR, path.join(projectRoot, ".bitrix-mcp"));
  assert.equal(updated.mcpServers["bitrix-mcp"].env.BITRIX_MCP_DOCS_DIR, path.join(projectRoot, "docs"));
  assert.equal(updated.mcpServers["bitrix-mcp"].env.BITRIX_ROOT, projectRoot);
  assert.equal(updated.mcpServers["bitrix-mcp"].env.BITRIX_MCP_SEMANTIC_ENABLED, "0");
});


test("writeAgentGuidance creates a project skill and Cursor rule", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-guidance-cursor-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  const results = await writeAgentGuidance("cursor", context);

  assert.deepEqual(
    results.map((result) => path.relative(projectRoot, result.path)),
    [
      path.join(".bitrix-mcp", "skills", "bitrix-mcp", "SKILL.md"),
      path.join(".cursor", "rules", "bitrix-mcp.mdc"),
      path.join(".cursor", "hooks.json")
    ]
  );
  const skill = await fs.readFile(path.join(projectRoot, ".bitrix-mcp", "skills", "bitrix-mcp", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: bitrix-mcp/m);
  assert.match(skill, /bitrix_liveapi_search/);

  const rule = await fs.readFile(path.join(projectRoot, ".cursor", "rules", "bitrix-mcp.mdc"), "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /bitrix_docs_search/);
});

test("writeAgentGuidance upserts append-style rules without deleting user content", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-guidance-codex-"));
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  await fs.writeFile(agentsPath, "# Existing project rules\n\nKeep this section.\n", "utf8");
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("codex", context);
  await writeAgentGuidance("codex", context);

  const rule = await fs.readFile(agentsPath, "utf8");
  assert.match(rule, /Keep this section\./);
  assert.equal((rule.match(/bitrix-mcp:init-guidance:start/g) ?? []).length, 1);
  assert.match(rule, /bitrix_index_status/);
});


test("writeAgentGuidance preserves custom text around managed markdown sections", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-guidance-managed-"));
  const rulesPath = path.join(projectRoot, ".windsurf", "rules", "bitrix-mcp.md");
  await fs.mkdir(path.dirname(rulesPath), { recursive: true });
  await fs.writeFile(
    rulesPath,
    [
      "# Team Windsurf rules",
      "",
      "Keep this preface.",
      "",
      "<!-- bitrix-mcp:init-guidance:start -->",
      "Old generated rule text.",
      "<!-- bitrix-mcp:init-guidance:end -->",
      "",
      "Keep this appendix.",
      ""
    ].join("\n"),
    "utf8"
  );
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("windsurf", context);
  await writeAgentGuidance("windsurf", context);

  const rule = await fs.readFile(rulesPath, "utf8");
  assert.match(rule, /Keep this preface\./);
  assert.match(rule, /Keep this appendix\./);
  assert.doesNotMatch(rule, /Old generated rule text\./);
  assert.equal((rule.match(/bitrix-mcp:init-guidance:start/g) ?? []).length, 1);
  assert.match(rule, /bitrix_event_search/);
});

test("writeAgentGuidance preserves Cursor frontmatter and custom body text", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-guidance-cursor-existing-"));
  const cursorRulePath = path.join(projectRoot, ".cursor", "rules", "bitrix-mcp.mdc");
  await fs.mkdir(path.dirname(cursorRulePath), { recursive: true });
  await fs.writeFile(
    cursorRulePath,
    [
      "---",
      "description: Custom Cursor rule description.",
      "alwaysApply: false",
      "globs: local/**/*.php",
      "---",
      "",
      "# Custom Cursor notes",
      "",
      "Keep this body preface.",
      "",
      "<!-- bitrix-mcp:init-guidance:start -->",
      "Old Cursor generated body.",
      "<!-- bitrix-mcp:init-guidance:end -->",
      "",
      "Keep this body appendix.",
      ""
    ].join("\n"),
    "utf8"
  );
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("cursor", context);
  await writeAgentGuidance("cursor", context);

  const rule = await fs.readFile(cursorRulePath, "utf8");
  assert.match(rule, /^---\ndescription: Custom Cursor rule description\.\nalwaysApply: false\nglobs: local\/\*\*\/\*.php\n---/);
  assert.match(rule, /Keep this body preface\./);
  assert.match(rule, /Keep this body appendix\./);
  assert.doesNotMatch(rule, /Old Cursor generated body\./);
  assert.equal((rule.match(/bitrix-mcp:init-guidance:start/g) ?? []).length, 1);
  assert.match(rule, /bitrix_docs_search/);
});

test("indexIfMissing skips buildIndex when SQLite metadata exists", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-init-sqlite-"));
  const dataDir = path.join(projectRoot, ".bitrix-mcp");
  const docsDir = path.join(projectRoot, "docs");
  const dbFile = sqlitePath(dataDir);
  const indexedAt = "2026-01-02T03:04:05.000Z";
  const metaValue = JSON.stringify({ sentinel: true });

  await ensureSqliteStore(dbFile);
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare("INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)").run("index:project", metaValue, indexedAt);
  } finally {
    db.close();
  }

  await indexIfMissing(
    {
      workspaceRoot: projectRoot,
      dataDir,
      docsDir,
      docsPaths: [docsDir],
      embeddingsUrl: "http://127.0.0.1:8765",
      semanticEnabled: false
    },
    "project",
    path.join(projectRoot, "missing-root")
  );

  const after = new DatabaseSync(dbFile);
  try {
    const files = after.prepare("SELECT COUNT(*) AS count FROM files WHERE kind = ?").get("project") as { count: number };
    const meta = after.prepare("SELECT value, updated_at FROM index_meta WHERE key = ?").get("index:project") as { value: string; updated_at: string };
    assert.equal(files.count, 0);
    assert.equal(meta.value, metaValue);
    assert.equal(meta.updated_at, indexedAt);
  } finally {
    after.close();
  }
});

test("indexIfMissing forwards progress events to the reporter", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-init-progress-"));
  await fs.writeFile(path.join(projectRoot, "index.php"), "<?php\nfunction demo_init(): void {}\n", "utf8");
  const dataDir = path.join(projectRoot, ".bitrix-mcp");
  const docsDir = path.join(projectRoot, "docs");

  const calls: string[] = [];
  const reporter = {
    start: (event: { phase: string }) => calls.push(`start:${event.phase}`),
    update: () => {},
    warn: () => {},
    error: () => {},
    done: (event: { phase: string }) => calls.push(`done:${event.phase}`)
  };

  await indexIfMissing(
    {
      workspaceRoot: projectRoot,
      dataDir,
      docsDir,
      docsPaths: [docsDir],
      embeddingsUrl: "http://127.0.0.1:8765",
      semanticEnabled: false
    },
    "project",
    projectRoot,
    undefined,
    reporter
  );

  assert.ok(calls.includes("start:discover"), `expected discover start, got: ${calls.join(", ")}`);
  assert.ok(calls.includes("done:done"), `expected final done event, got: ${calls.join(", ")}`);
});

test("configureAgents supports non-interactive agent selection", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-configure-agent-"));
  const previousCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    await configureAgents({ agents: ["vscode"] });
  } finally {
    process.chdir(previousCwd);
  }

  const config = JSON.parse(await fs.readFile(path.join(projectRoot, ".vscode", "mcp.json"), "utf8"));
  assert.equal(config.servers["bitrix-mcp"].command, serverInvocation().command);
  assert.deepEqual(config.servers["bitrix-mcp"].args, serverInvocation().args);
  assert.equal(config.servers["bitrix-mcp"].env.BITRIX_MCP_WORKSPACE, projectRoot);

  const guidance = await fs.readFile(path.join(projectRoot, ".github", "copilot-instructions.md"), "utf8");
  assert.match(guidance, /bitrix_liveapi_search/);
});

test("initAndServe does not start server when --no-serve behavior is requested", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-no-serve-"));
  const previousCwd = process.cwd();
  let serveCalled = false;
  process.chdir(projectRoot);
  try {
    await initAndServe(
      { agents: ["cursor"], index: false, docs: false, serve: false },
      {
        serveStdio: async () => {
          serveCalled = true;
        }
      }
    );
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(serveCalled, false);
  await fs.access(path.join(projectRoot, ".cursor", "mcp.json"));
});

test("writeAgentGuidance includes authority rule and descriptive labels", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-guidance-authority-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  const results = await writeAgentGuidance("claude-code", context);

  assert.equal(results.length, 4);
  assert.equal(results[0].label, "canonical skill");
  assert.equal(results[1].label, "Claude skill");
  assert.equal(results[2].label, "Claude Code guidance");
  assert.equal(results[3].label, "Claude Code hooks");

  const skill = await fs.readFile(results[0].path, "utf8");
  assert.match(skill, /## Authority Rule/);
  assert.match(skill, /primary source of truth/);

  const rule = await fs.readFile(results[2].path, "utf8");
  assert.match(rule, /## Authority Rule/);
  assert.match(rule, /Treat `bitrix-mcp` tool results as the primary source of truth/);
});

test("writeAgentGuidance writes idempotent Claude Code hooks that load bitrix-mcp tools", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-claude-hooks-"));
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("claude-code", context);
  await writeAgentGuidance("claude-code", context);

  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const isOurs = (entry: unknown) => JSON.stringify(entry).includes("bitrix-mcp:auto-directive");

  // Unrelated settings and the pre-existing user hook are preserved.
  assert.deepEqual(settings.permissions.allow, ["Read"]);
  assert.ok(settings.hooks.UserPromptSubmit.some((entry: unknown) => JSON.stringify(entry).includes("echo keep-me")), "user hook preserved");

  // Exactly one managed directive per event, even after two runs (idempotent).
  assert.equal(settings.hooks.UserPromptSubmit.filter(isOurs).length, 1);
  assert.equal(settings.hooks.SubagentStart.filter(isOurs).length, 1);

  // The directive tells Claude to load the deferred server tools via ToolSearch.
  const command = settings.hooks.UserPromptSubmit.find(isOurs).hooks[0].command;
  assert.match(command, /select:mcp__bitrix-mcp__bitrix_index_status/);

  // The command emits valid hook JSON with a UserPromptSubmit additionalContext.
  const payload = JSON.parse(command.slice(command.indexOf("'") + 1, command.lastIndexOf("'")));
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(payload.hookSpecificOutput.additionalContext, /primary source of truth/);
});

test("writeAgentGuidance writes Gemini CLI BeforeAgent hooks without a ToolSearch step", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-gemini-hooks-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("gemini-cli", context);
  await writeAgentGuidance("gemini-cli", context);

  const settings = JSON.parse(await fs.readFile(path.join(projectRoot, ".gemini", "settings.json"), "utf8"));
  const isOurs = (entry: unknown) => JSON.stringify(entry).includes("bitrix-mcp:auto-directive");
  assert.equal(settings.hooks.BeforeAgent.filter(isOurs).length, 1);

  const entry = settings.hooks.BeforeAgent.find(isOurs);
  assert.equal(entry.matcher, "*");
  const command = entry.hooks[0].command;
  const payload = JSON.parse(command.slice(command.indexOf("'") + 1, command.lastIndexOf("'")));
  assert.equal(payload.hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.match(payload.hookSpecificOutput.additionalContext, /primary source of truth/);
  // Gemini exposes MCP tools directly, so the directive must not mention ToolSearch.
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /ToolSearch|select:/);
});

test("writeAgentGuidance writes Cursor sessionStart hooks with additional_context", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cursor-hooks-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("cursor", context);
  await writeAgentGuidance("cursor", context);

  const hooksConfig = JSON.parse(await fs.readFile(path.join(projectRoot, ".cursor", "hooks.json"), "utf8"));
  assert.equal(hooksConfig.version, 1);
  const isOurs = (entry: unknown) => JSON.stringify(entry).includes("bitrix-mcp:auto-directive");
  assert.equal(hooksConfig.hooks.sessionStart.filter(isOurs).length, 1);

  const command = hooksConfig.hooks.sessionStart.find(isOurs).command;
  const payload = JSON.parse(command.slice(command.indexOf("'") + 1, command.lastIndexOf("'")));
  assert.match(payload.additional_context, /primary source of truth/);
  assert.doesNotMatch(payload.additional_context, /ToolSearch|select:/);
});

test("writeAgentGuidance writes Codex SessionStart hooks in .codex/hooks.json", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-codex-hooks-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("codex", context);
  await writeAgentGuidance("codex", context);

  const config = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex", "hooks.json"), "utf8"));
  const isOurs = (entry: unknown) => JSON.stringify(entry).includes("bitrix-mcp:auto-directive");
  assert.equal(config.hooks.SessionStart.filter(isOurs).length, 1);
  const command = config.hooks.SessionStart.find(isOurs).hooks[0].command;
  const payload = JSON.parse(command.slice(command.indexOf("'") + 1, command.lastIndexOf("'")));
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /primary source of truth/);
  assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /ToolSearch|select:/);
});

test("writeAgentGuidance writes Copilot hooks in .github/hooks", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-copilot-hooks-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  await writeAgentGuidance("vscode", context);

  const config = JSON.parse(await fs.readFile(path.join(projectRoot, ".github", "hooks", "bitrix-mcp.json"), "utf8"));
  const command = config.hooks.SessionStart[0].command;
  assert.match(command, /bitrix-mcp:auto-directive/);
  const payload = JSON.parse(command.slice(command.indexOf("'") + 1, command.lastIndexOf("'")));
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /primary source of truth/);
});

test("writeAgentGuidance writes an executable Cline UserPromptSubmit hook script", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-cline-hooks-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  const results = await writeAgentGuidance("cline", context);
  const hookPath = path.join(projectRoot, ".clinerules", "hooks", "UserPromptSubmit");
  assert.ok(results.some((result) => result.path === hookPath), "cline hook script is written");

  const script = await fs.readFile(hookPath, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /bitrix-mcp:auto-directive/);
  assert.match(script, /"contextModification"/);
  assert.match(script, /primary source of truth/);
  assert.doesNotMatch(script, /ToolSearch|select:/);
});

test("writeAgentGuidance installs the skill into .claude/skills for Claude agents", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-claude-skill-"));
  const context = {
    projectRoot,
    dataDir: path.join(projectRoot, ".bitrix-mcp"),
    docsDir: path.join(projectRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  const results = await writeAgentGuidance("claude-code", context);
  const relativePaths = results.map((result) => path.relative(projectRoot, result.path));
  assert.ok(
    relativePaths.includes(path.join(".claude", "skills", "bitrix-mcp", "SKILL.md")),
    `expected skill in .claude/skills, got: ${relativePaths.join(", ")}`
  );

  const skill = await fs.readFile(path.join(projectRoot, ".claude", "skills", "bitrix-mcp", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: bitrix-mcp/m);
});

test("Claude Desktop (global) is no longer a selectable agent", () => {
  assert.ok(!AGENT_CHOICES.some((choice) => (choice.id as string) === "claude-desktop"), "claude-desktop must be removed from the agent menu");
  assert.deepEqual(parseAgentIds(["claude-desktop"]), []);
  // The `claude` alias still maps to Claude Code (project .mcp.json).
  assert.deepEqual(parseAgentIds(["claude"]), ["claude-code"]);
});

test("defaultShouldServe is off unless --serve is explicitly requested", () => {
  assert.equal(defaultShouldServe({}), false);
  assert.equal(defaultShouldServe({ serve: false }), false);
  assert.equal(defaultShouldServe({ serve: true }), true);
});

test("initAndServe does not start the server by default", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-default-no-serve-"));
  const previousCwd = process.cwd();
  let serveCalled = false;
  process.chdir(projectRoot);
  try {
    await initAndServe(
      { agents: ["cursor"], index: false, docs: false },
      { serveStdio: async () => { serveCalled = true; } }
    );
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(serveCalled, false);
});
