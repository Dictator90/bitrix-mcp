import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import type { RuntimePaths } from "../src/config/paths.js";
import type { IndexManifest } from "../src/types.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

test("MCP bitrix_index_template accepts templatePath", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    embeddingsUrl: "http://127.0.0.1:8765"
  };
  const server = createMcpServer(paths);
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;

  const result = await tool.handler({ templatePath: "local/templates/my_template" });
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, "template-index.json"), "utf8")) as IndexManifest;

  assert.deepEqual(result, { content: [{ type: "text", text: "Indexed 1 template files." }] });
  assert.equal(manifest.root, path.join(fixtureRoot, "local/templates/my_template"));
  assert.ok(manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});
