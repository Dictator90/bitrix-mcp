import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqlitePath } from "../src/config/paths.js";
import { configureAgents, envConfig, indexIfMissing, initAndServe, writeAgentGuidance, writeMcpServersConfig } from "../src/init/init.js";
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
  assert.equal(updated.mcpServers["bitrix-mcp"].command, "bitrix-mcp");
  assert.deepEqual(updated.mcpServers["bitrix-mcp"].args, ["serve"]);
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
    [path.join(".bitrix-mcp", "skills", "bitrix-mcp", "SKILL.md"), path.join(".cursor", "rules", "bitrix-mcp.mdc")]
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
  assert.equal(config.servers["bitrix-mcp"].command, "bitrix-mcp");
  assert.deepEqual(config.servers["bitrix-mcp"].args, ["serve"]);
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
