import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { envConfig, writeMcpServersConfig } from "../src/init/init.js";

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
