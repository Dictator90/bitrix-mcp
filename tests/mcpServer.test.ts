import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { readIndexFromSqlite } from "../src/indexer/sqliteStore.js";
import { addPathDocSource } from "../src/resources/docs.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

test("MCP bitrix_index_template accepts templatePath", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765"
  };
  const server = createMcpServer(paths);
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;

  const result = await tool.handler({ templatePath: "local/templates/my_template" });
  await assert.rejects(fs.readFile(path.join(dataDir, "template-index.json"), "utf8"));
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");

  assert.deepEqual(result, { content: [{ type: "text", text: "Indexed 1 template files." }] });
  assert.equal(manifest?.root, path.join(fixtureRoot, "local/templates/my_template"));
  assert.ok(manifest?.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});

test("MCP bitrix_index_template keeps root as deprecated templatePath alias", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-root-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765"
  };
  const server = createMcpServer(paths);
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;

  await tool.handler({ root: "local/templates/my_template" });
  await assert.rejects(fs.readFile(path.join(dataDir, "template-index.json"), "utf8"));
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");

  assert.equal(manifest?.root, path.join(fixtureRoot, "local/templates/my_template"));
  assert.ok(manifest?.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});


test("MCP bitrix_liveapi_search reads symbols from SQLite", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-search-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765"
  };
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_liveapi_search.handler({ query: "demo_helper", limit: 5 });
  const results = JSON.parse(result.content[0].text) as Array<{ item: { name: string } }>;

  assert.equal(results[0]?.item.name, "demo_helper");

  const eventResult = await tools.bitrix_event_search.handler({ query: "Demo", module: "main", limit: 5 });
  const eventResults = JSON.parse(eventResult.content[0].text) as Array<{ item: { eventName: string; handlerClass: string; handlerMethod: string } }>;

  assert.equal(eventResults[0]?.item.eventName, "OnBeforeProlog");
  assert.equal(eventResults[0]?.item.handlerClass, "Demo");
  assert.equal(eventResults[0]?.item.handlerMethod, "handler");
});

test("MCP bitrix_docs_search searches local docs without embeddings service", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-docs-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765"
  };
  await addPathDocSource(dataDir, paths.docsDir);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_docs.handler({});
  const result = await tools.bitrix_docs_search.handler({ query: "managed cache", limit: 5 });
  const results = JSON.parse(result.content[0].text) as Array<{ item: { text: string } }>;

  assert.match(results[0]?.item.text ?? "", /managed cache/);
});
