import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { indexPath, sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { buildIndex, DEFAULT_INSTALL_ASSET_PATTERNS } from "../src/indexer/indexer.js";
import { readIndexFromSqlite, writeBitrixRelations, writeIndexToSqlite } from "../src/indexer/sqliteStore.js";
import { addPathDocSource } from "../src/resources/docs.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function runtimePaths(dataDir: string, workspaceRoot = fixtureRoot): RuntimePaths {
  return {
    workspaceRoot,
    dataDir,
    docsDir: path.join(workspaceRoot, "docs"),
    docsPaths: [path.join(workspaceRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
}

async function withOutsideWorkspaceOptIn<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE;
  process.env.BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE = "1";
  try {
    return await work();
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE;
    } else {
      process.env.BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE = previous;
    }
  }
}

test("MCP bitrix_read_file_context reads fixture file context", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-read-context-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.bitrix_read_file_context;

  const result = await tool.handler({ file: "index.php", line: 7, before: 1, after: 2, maxChars: 1000 });
  const context = JSON.parse(result.content[0].text) as {
    metadata: { absolutePath: string; relativePath: string; language: string; startLine: number; endLine: number; totalLines: number; truncated: boolean };
    numberedLines: string;
  };

  assert.equal(context.metadata.absolutePath, path.join(fixtureRoot, "index.php"));
  assert.equal(context.metadata.relativePath, "index.php");
  assert.equal(context.metadata.language, "php");
  assert.equal(context.metadata.startLine, 6);
  assert.equal(context.metadata.endLine, 9);
  assert.equal(context.metadata.totalLines, 14);
  assert.equal(context.metadata.truncated, false);
  assert.match(context.numberedLines, /^7: function demo_helper\(string \$name\): string/m);
  assert.match(context.numberedLines, /^9:     return \$name;/m);
});

test("MCP bitrix_read_file_context rejects path traversal outside workspace and data dir", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-read-context-guard-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-read-context-outside-"));
  const outsideFile = path.join(outsideDir, "secret.php");
  await fs.writeFile(outsideFile, "<?php\n$secret = true;\n");
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_read_file_context;

  await assert.rejects(
    tool.handler({ file: path.relative(fixtureRoot, outsideFile), line: 1 }),
    /MCP path restriction: bitrix_read_file_context parameter "file" must resolve inside one of the allowed roots/
  );
});


test("MCP bitrix_read_symbol_context reads method context with a file filter", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-method-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_read_symbol_context.handler({ name: "executeComponent", type: "method", file: "index.php", before: 1, after: 1, maxChars: 1000 });
  const context = JSON.parse(result.content[0].text) as { ambiguous: boolean; symbol: { type: string; name: string; file: string; line: number; lineEnd?: number }; context: { metadata: { relativePath: string; startLine: number; endLine: number }; numberedLines: string } };

  assert.equal(context.ambiguous, false);
  assert.equal(context.symbol.type, "method");
  assert.equal(context.symbol.name, "executeComponent");
  assert.equal(context.symbol.file, "index.php");
  assert.equal(context.symbol.line, 4);
  assert.equal(context.symbol.lineEnd, 4);
  assert.equal(context.context.metadata.relativePath, "index.php");
  assert.match(context.context.numberedLines, /public function executeComponent\(\): void/);
});

test("MCP bitrix_read_symbol_context reads class context", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-class-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_read_symbol_context.handler({ name: "DemoComponent", type: "class", before: 0, after: 1, maxChars: 1000 });
  const context = JSON.parse(result.content[0].text) as { ambiguous: boolean; symbol: { type: string; lineEnd?: number }; context: { metadata: { startLine: number; endLine: number }; numberedLines: string } };

  assert.equal(context.ambiguous, false);
  assert.equal(context.symbol.type, "class");
  assert.equal(context.symbol.lineEnd, 5);
  assert.equal(context.context.metadata.startLine, 2);
  assert.match(context.context.numberedLines, /^2: class DemoComponent/m);
});

test("MCP bitrix_read_symbol_context returns candidates for ambiguous symbols", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-ambiguous-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
  const fixtureFile = path.join(fixtureRoot, "index.php");

  await tools.bitrix_index_project.handler({});
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: fixtureRoot,
    kind: "template",
    files: [{
      path: fixtureFile,
      relativePath: "index.php",
      kind: "template",
      size: 1,
      mtimeMs: 1,
      language: "php",
      symbols: [{ type: "function", name: "demo_helper", file: fixtureFile, line: 7, lineEnd: 10 }]
    }]
  }, { force: true });
  const result = await tools.bitrix_read_symbol_context.handler({ name: "demo_helper", type: "function", maxChars: 1000 });
  const context = JSON.parse(result.content[0].text) as { ambiguous: boolean; candidates: Array<{ name: string; file: string; kind: string; line: number }> };

  assert.equal(context.ambiguous, true);
  assert.ok(context.candidates.length >= 2);
  assert.ok(context.candidates.some((candidate) => candidate.kind === "project" && candidate.file === "index.php"));
  assert.ok(context.candidates.some((candidate) => candidate.kind === "template" && candidate.file === "index.php"));
});

test("MCP bitrix_read_symbol_context includeBody uses indexed lineEnd", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-body-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_read_symbol_context.handler({ name: "DemoComponent", type: "class", includeBody: true, before: 0, after: 0, maxChars: 1000 });
  const context = JSON.parse(result.content[0].text) as { context: { metadata: { startLine: number; endLine: number }; numberedLines: string } };

  assert.equal(context.context.metadata.startLine, 2);
  assert.equal(context.context.metadata.endLine, 5);
  assert.match(context.context.numberedLines, /^5: }/m);
});

test("MCP bitrix_read_symbol_context enforces file read allowlist for indexed symbols", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-guard-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-symbol-outside-"));
  const outsideFile = path.join(outsideDir, "secret.php");
  await fs.writeFile(outsideFile, "<?php\nfunction secret_symbol(): void {}\n");
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: fixtureRoot,
    kind: "project",
    files: [{
      path: outsideFile,
      relativePath: "secret.php",
      kind: "project",
      size: 1,
      mtimeMs: 1,
      language: "php",
      symbols: [{ type: "function", name: "secret_symbol", file: outsideFile, line: 2, lineEnd: 2 }]
    }]
  }, { force: true });
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_read_symbol_context;

  await assert.rejects(
    tool.handler({ name: "secret_symbol", type: "function" }),
    /MCP path restriction: bitrix_read_file_context parameter "file" must resolve inside one of the allowed roots/
  );
});

test("MCP bitrix_read_symbol_context maxChars truncates output", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-symbol-truncate-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_read_symbol_context.handler({ name: "demo_helper", type: "function", includeBody: true, before: 0, after: 20, maxChars: 100 });
  const context = JSON.parse(result.content[0].text) as { context: { metadata: { truncated: boolean }; numberedLines: string } };

  assert.equal(context.context.metadata.truncated, true);
  assert.ok(context.context.numberedLines.length <= 100);
});

test("MCP bitrix_index_template accepts templatePath", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
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
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  const server = createMcpServer(paths);
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;

  await tool.handler({ root: "local/templates/my_template" });
  await assert.rejects(fs.readFile(path.join(dataDir, "template-index.json"), "utf8"));
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");

  assert.equal(manifest?.root, path.join(fixtureRoot, "local/templates/my_template"));
  assert.ok(manifest?.files.some((file) => file.symbols.some((symbol) => symbol.name === "my_template_helper")));
});

test("MCP bitrix_index_project rejects roots outside workspace by default", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-project-guard-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-outside-project-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_project;

  await assert.rejects(
    tool.handler({ root: outsideRoot }),
    /MCP path restriction: bitrix_index_project parameter "root" must resolve inside workspaceRoot .*BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1/
  );
});

test("MCP bitrix_index_project allows outside workspace when explicitly enabled", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-project-opt-in-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-outside-project-opt-in-"));
  await fs.writeFile(path.join(outsideRoot, "outside.php"), "<?php\nfunction outside_workspace_helper() {}\n");
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_project;

  await withOutsideWorkspaceOptIn(async () => {
    await tool.handler({ root: outsideRoot });
  });
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "project");

  assert.equal(manifest?.root, path.resolve(outsideRoot));
  assert.ok(manifest?.files.some((file) => file.symbols.some((symbol) => symbol.name === "outside_workspace_helper")));
});

test("MCP bitrix_index_template rejects absolute templatePath and parent traversal by default", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-template-guard-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;

  await assert.rejects(
    tool.handler({ templatePath: path.join(fixtureRoot, "local/templates/my_template") }),
    /MCP path restriction: bitrix_index_template parameter "templatePath" must be relative .*BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1/
  );
  await assert.rejects(
    tool.handler({ templatePath: "../outside-template" }),
    /MCP path restriction: bitrix_index_template parameter "templatePath" must not contain "\.\." .*BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1/
  );
});

test("MCP bitrix_index_template allows absolute or parent paths when explicitly enabled", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-template-opt-in-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-outside-template-opt-in-"));
  await fs.writeFile(path.join(outsideRoot, "outside-template.php"), "<?php\nfunction outside_template_helper() {}\n");
  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools.bitrix_index_template;
  const traversingTemplatePath = path.relative(fixtureRoot, outsideRoot);

  await withOutsideWorkspaceOptIn(async () => {
    await tool.handler({ templatePath: traversingTemplatePath });
    await tool.handler({ templatePath: outsideRoot });
  });
  const manifest = await readIndexFromSqlite(sqlitePath(dataDir), "template");

  assert.equal(manifest?.root, path.resolve(outsideRoot));
  assert.ok(manifest?.files.some((file) => file.symbols.some((symbol) => symbol.name === "outside_template_helper")));
});


test("MCP bitrix_relation_search is registered and searches relation storage", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-relations-"));
  const paths = runtimePaths(dataDir);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
  const relationFile = path.join(fixtureRoot, "local", "modules", "vendor.module", "lib", "relation.php");

  assert.ok(tools.bitrix_relation_search);
  await writeBitrixRelations(sqlitePath(dataDir), [
    {
      sourceType: "event",
      sourceName: "main:OnBeforeProlog",
      targetType: "method",
      targetName: "Vendor\\Module\\Handler::run",
      relationType: "handles",
      file: relationFile,
      line: 17,
      module: "main",
      kind: "event",
      metadata: { sort: 100 }
    }
  ]);

  const compactResult = await tools.bitrix_relation_search.handler({ sourceType: "event" });
  const compact = JSON.parse(compactResult.content[0].text) as Array<{ source: string; target: string; relationType: string; file: string; line: number; item?: unknown }>;
  assert.equal(compact[0]?.source, "event:main:OnBeforeProlog");
  assert.equal(compact[0]?.target, "method:Vendor\\Module\\Handler::run");
  assert.equal(compact[0]?.relationType, "handles");
  assert.equal(compact[0]?.item, undefined);

  const fullResult = await tools.bitrix_relation_search.handler({ targetType: "method", format: "full" });
  const full = JSON.parse(fullResult.content[0].text) as Array<{ sourceType: string; metadata: { sort: number } }>;
  assert.equal(full[0]?.sourceType, "event");
  assert.deepEqual(full[0]?.metadata, { sort: 100 });
});


test("MCP graph tools are registered and query relation graph", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-graph-"));
  const paths = runtimePaths(dataDir);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_graph_neighbors);
  assert.ok(tools.bitrix_graph_traverse);
  assert.ok(tools.bitrix_impact_radius);

  await writeBitrixRelations(sqlitePath(dataDir), [
    { sourceType: "file", sourceName: "local/php_interface/init.php", targetType: "event", targetName: "main:OnBeforeProlog", relationType: "registers_event_handler", file: "local/php_interface/init.php", line: 12, module: "main", kind: "project" },
    { sourceType: "event", sourceName: "main:OnBeforeProlog", targetType: "method", targetName: "Vendor\\Module\\Handler::run", relationType: "handles_event", file: "local/php_interface/init.php", line: 13, module: "main", kind: "project" }
  ]);

  const neighborsResult = await tools.bitrix_graph_neighbors.handler({ nodeType: "event", nodeName: "main:OnBeforeProlog", direction: "both" });
  const neighbors = JSON.parse(neighborsResult.content[0].text) as { neighbors: Array<{ type: string; relationType: string }> };
  assert.equal(neighbors.neighbors.some((neighbor) => neighbor.type === "method" && neighbor.relationType === "handles_event"), true);

  const traverseResult = await tools.bitrix_graph_traverse.handler({ startType: "file", startName: "local/php_interface/init.php", maxDepth: 2 });
  const traversal = JSON.parse(traverseResult.content[0].text) as { nodes: Array<{ id: string; depth: number }> };
  assert.equal(traversal.nodes.some((node) => node.id === "method:Vendor\\Module\\Handler::run" && node.depth === 2), true);

  const impactResult = await tools.bitrix_impact_radius.handler({ files: ["local/php_interface/init.php"], maxDepth: 2 });
  const impact = JSON.parse(impactResult.content[0].text) as { impacted: { events: unknown[]; methods: unknown[] }; risk: { score: number } };
  assert.equal(impact.impacted.events.length, 1);
  assert.equal(impact.impacted.methods.length, 1);
  assert.ok(impact.risk.score > 0);
});

test("MCP bitrix_liveapi_search reads symbols from SQLite", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-search-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_liveapi_search.handler({ query: "demo_helper", limit: 5 });
  const results = JSON.parse(result.content[0].text) as Array<{ name: string; type: string; file: string; line: number }>;

  assert.equal(results[0]?.name, "demo_helper");
  assert.equal(results[0]?.type, "function");
  assert.equal(results[0]?.file, "index.php");
  assert.ok(results[0]?.line);

  const eventResult = await tools.bitrix_event_search.handler({ query: "Demo", module: "main", limit: 5 });
  const eventResults = JSON.parse(eventResult.content[0].text) as Array<{ type: string; name: string; module: string; file: string; line: number }>;

  assert.equal(eventResults[0]?.type, "event");
  assert.equal(eventResults[0]?.name, "OnBeforeProlog");
  assert.equal(eventResults[0]?.module, "main");
  assert.equal(eventResults[0]?.file, "index.php");

  const fullEventResult = await tools.bitrix_event_search.handler({ query: "Demo", module: "main", limit: 5, format: "full" });
  const fullEventResults = JSON.parse(fullEventResult.content[0].text) as Array<{ item: { eventName: string; handlerClass: string; handlerMethod: string } }>;
  assert.equal(fullEventResults[0]?.item.handlerClass, "Demo");
  assert.equal(fullEventResults[0]?.item.handlerMethod, "handler");
});

test("MCP bitrix_docs_search searches local docs without embeddings service", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-docs-"));
  const paths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  await addPathDocSource(dataDir, paths.docsDir);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_docs.handler({});
  const result = await tools.bitrix_docs_search.handler({ query: "managed cache", limit: 5 });
  const results = JSON.parse(result.content[0].text) as Array<{ excerpt: string; type: string; uri: string }>;

  assert.equal(results[0]?.type, "doc");
  assert.match(results[0]?.excerpt ?? "", /\*\*managed\*\* \*\*cache\*\*/i);
  assert.equal("item" in (results[0] ?? {}), false);
});



test("MCP bitrix_docs_for_symbol returns compact symbol documentation links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doc-symbol-root-"));
  const docsDir = path.join(root, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "getlist.md"), "# CIBlockElement::GetList\n\nUse CIBlockElement::GetList to fetch iblock elements with filters and selected fields.\n");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doc-symbol-db-"));
  const paths = runtimePaths(dataDir, root);
  await addPathDocSource(dataDir, docsDir);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_docs.handler({});
  const result = await tools.bitrix_docs_for_symbol.handler({ symbol: "CIBlockElement::GetList", limit: 5 });
  const payload = JSON.parse(result.content[0].text) as { symbol: string; results: Array<{ title: string; uri: string; path: string; chunkIndex: number; excerpt: string }> };

  assert.equal(payload.symbol, "CIBlockElement::GetList");
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0]?.title, "CIBlockElement::GetList");
  assert.ok(payload.results[0]?.uri.startsWith("bitrix-docs://"));
  assert.equal(payload.results[0]?.chunkIndex, 0);
  assert.match(payload.results[0]?.excerpt ?? "", /filters and selected fields/);
  assert.equal("docUri" in (payload.results[0] ?? {}), false);
});

test("MCP bitrix_docs_for_symbol returns empty results when no docs match", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-doc-symbol-empty-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  const result = await tools.bitrix_docs_for_symbol.handler({ symbol: "CEvent::Send", limit: 5 });
  const payload = JSON.parse(result.content[0].text) as { symbol: string; results: unknown[] };

  assert.equal(payload.symbol, "CEvent::Send");
  assert.deepEqual(payload.results, []);
});

test("MCP bitrix_explain_api_usage combines docs, local usages, core definitions, and recommendations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-explain-root-"));
  const docsDir = path.join(root, "docs");
  const localFile = path.join(root, "local", "usage.php");
  const coreFile = path.join(root, "bitrix", "modules", "iblock", "classes", "general", "iblockelement.php");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.mkdir(path.dirname(coreFile), { recursive: true });
  await fs.writeFile(path.join(docsDir, "getlist.md"), "# CIBlockElement::GetList\n\nCIBlockElement::GetList accepts order, filter, group, navigation, and select parameters.\n");
  await fs.writeFile(localFile, "<?php CIBlockElement::GetList([], ['ACTIVE' => 'Y']);\n");
  await fs.writeFile(coreFile, "<?php class CIBlockElement { public static function GetList() {} }\n");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-explain-db-"));
  const paths = runtimePaths(dataDir, root);
  await addPathDocSource(dataDir, docsDir);
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: "project",
    files: [{ path: localFile, relativePath: "local/usage.php", kind: "project", size: 1, mtimeMs: 1, language: "php", symbols: [{ type: "static_call", name: "CIBlockElement::GetList", className: "CIBlockElement", file: localFile, line: 1, signature: "CIBlockElement::GetList([], ['ACTIVE' => 'Y']);" }] }]
  }, { force: true });
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: "bitrix",
    files: [{ path: coreFile, relativePath: "bitrix/modules/iblock/classes/general/iblockelement.php", kind: "bitrix", size: 1, mtimeMs: 1, language: "php", symbols: [{ type: "method", name: "CIBlockElement::GetList", className: "CIBlockElement", file: coreFile, line: 1, signature: "public static function GetList()" }] }]
  }, { force: true });

  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
  await tools.bitrix_index_docs.handler({});
  const result = await tools.bitrix_explain_api_usage.handler({ query: "CIBlockElement::GetList", limit: 5 });
  const payload = JSON.parse(result.content[0].text) as { query: string; docs: unknown[]; localUsages: Array<{ kind: string; name: string }>; coreDefinitions: Array<{ kind: string; name: string }>; relations: unknown[]; recommendations: string[] };

  assert.equal(payload.query, "CIBlockElement::GetList");
  assert.ok(payload.docs.length >= 1);
  assert.ok(payload.localUsages.some((usage) => usage.kind === "project" && usage.name === "CIBlockElement::GetList"));
  assert.ok(payload.coreDefinitions.some((definition) => definition.kind === "bitrix" && definition.name === "CIBlockElement::GetList"));
  assert.deepEqual(payload.recommendations, ["Check filter keys, selected fields, permissions, and pagination."]);
});

test("MCP bitrix_explain_api_usage returns local usage when docs are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-explain-local-root-"));
  const localFile = path.join(root, "local", "mail.php");
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, "<?php CEvent::Send('DEMO', SITE_ID, []);\n");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-explain-local-db-"));
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: "project",
    files: [{ path: localFile, relativePath: "local/mail.php", kind: "project", size: 1, mtimeMs: 1, language: "php", symbols: [{ type: "static_call", name: "CEvent::Send", className: "CEvent", file: localFile, line: 1, signature: "CEvent::Send('DEMO', SITE_ID, []);" }] }]
  }, { force: true });

  const server = createMcpServer(runtimePaths(dataDir, root));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
  const result = await tools.bitrix_explain_api_usage.handler({ query: "CEvent::Send", limit: 5 });
  const payload = JSON.parse(result.content[0].text) as { docs: unknown[]; localUsages: Array<{ name: string }>; coreDefinitions: unknown[]; recommendations: string[] };

  assert.deepEqual(payload.docs, []);
  assert.ok(payload.localUsages.some((usage) => usage.name === "CEvent::Send"));
  assert.deepEqual(payload.coreDefinitions, []);
  assert.deepEqual(payload.recommendations, ["Check event name, site ID, fields, and mail templates."]);
});

test("MCP semantic docs search tool is optional", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-semantic-"));
  const basePaths: RuntimePaths = {
    workspaceRoot: fixtureRoot,
    dataDir,
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };

  const disabledServer = createMcpServer(basePaths);
  const disabledTools = (disabledServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.equal(disabledTools.bitrix_semantic_docs_search, undefined);

  const enabledServer = createMcpServer({ ...basePaths, semanticEnabled: true });
  const enabledTools = (enabledServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(enabledTools.bitrix_semantic_docs_search);
});


test("MCP bitrix_module_usage_search is registered and returns compact module usages", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-module-usages-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-module-root-"));
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), "<?php\n\\Bitrix\\Main\\Loader::includeModule('iblock');\n", "utf8");

  const server = createMcpServer(runtimePaths(dataDir, root));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_module_usage_search);
  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_module_usage_search.handler({ module: "iblock", limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ module: string; call: string; kind: string; file: string; line: number; signature: string }>;

  assert.deepEqual(compact[0], {
    module: "iblock",
    call: "Loader::includeModule",
    kind: "project",
    file: slashPath("local/php_interface/init.php"),
    line: 2,
    signature: "\\Bitrix\\Main\\Loader::includeModule('iblock')"
  });
});

test("MCP bitrix_agent_search is registered and returns compact agents", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-agents-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-agent-root-"));
  const installFile = path.join(root, "local", "modules", "vendor.module", "install", "index.php");
  await fs.mkdir(path.dirname(installFile), { recursive: true });
  await fs.writeFile(installFile, String.raw`<?php
CAgent::AddAgent("\\Vendor\\Module\\Agent::run();", "vendor.module", "N", 86400);
`, "utf8");

  const server = createMcpServer({ ...runtimePaths(dataDir, root), bitrixRoot: root });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_agent_search);
  await tools.bitrix_index_all.handler({});
  // Install assets are opt-in (not indexed by bitrix_index_all by default), so
  // index the install scope explicitly to exercise install-agent search.
  await buildIndex({ root, kind: "install", outFile: indexPath(dataDir, "install"), patterns: DEFAULT_INSTALL_ASSET_PATTERNS, force: true });
  const result = await tools.bitrix_agent_search.handler({ query: "Agent::run", module: "vendor.module", kind: "install", limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ name: string; module: string; periodic: string; interval: number; kind: string; file: string; line: number; signature: string }>;

  assert.deepEqual(compact[0], {
    name: "\\Vendor\\Module\\Agent::run",
    module: "vendor.module",
    periodic: "N",
    interval: 86400,
    kind: "install",
    file: slashPath("local/modules/vendor.module/install/index.php"),
    line: 2,
    signature: 'CAgent::AddAgent("\\\\Vendor\\\\Module\\\\Agent::run();", "vendor.module", "N", 86400);'
  });
});

test("MCP bitrix_mail_event_search is registered and returns compact mail events", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-mail-events-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-mail-root-"));
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/mail.php"), String.raw`<?php
CEvent::Send('SALE_NEW_ORDER', SITE_ID, $fields);
AddEventHandler('main', 'OnBeforeEventSend', ['MailHandlers', 'beforeSend']);
`, "utf8");

  const server = createMcpServer(runtimePaths(dataDir, root));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_mail_event_search);
  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_mail_event_search.handler({ eventName: "SALE_NEW_ORDER", includeHandlers: true, limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ eventName: string; api: string; siteId: string; kind: string; file: string; line: number; signature: string; handlers: Array<{ eventName: string; handlerClass: string; handlerMethod: string }> }>;

  assert.equal(compact[0]?.eventName, "SALE_NEW_ORDER");
  assert.equal(compact[0]?.api, "CEvent::Send");
  assert.equal(compact[0]?.siteId, "SITE_ID");
  assert.equal(compact[0]?.kind, "project");
  assert.equal(compact[0]?.file, slashPath("local/php_interface/mail.php"));
  assert.equal(compact[0]?.line, 2);
  assert.match(compact[0]?.signature, /CEvent::Send/);
  assert.equal(compact[0]?.handlers?.[0]?.eventName, "OnBeforeEventSend");
  assert.equal(compact[0]?.handlers?.[0]?.handlerClass, "MailHandlers");
  assert.equal(compact[0]?.handlers?.[0]?.handlerMethod, "beforeSend");
});

test("MCP ORM tools are registered and return compact ORM records", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-orm-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-orm-root-"));
  const entityFile = path.join(root, "local", "modules", "vendor.module", "lib", "product.php");
  const usageFile = path.join(root, "local", "modules", "vendor.module", "lib", "usage.php");
  await fs.mkdir(path.dirname(entityFile), { recursive: true });
  await fs.writeFile(entityFile, String.raw`<?php
namespace Vendor\Module;
use Bitrix\Main\ORM\Data\DataManager;
class ProductTable extends DataManager
{
    public static function getTableName() { return 'vendor_product'; }
    public static function getMap() { return [new IntegerField('ID', ['primary' => true]), new ReferenceField('USER', UserTable::class)]; }
}
`, "utf8");
  await fs.writeFile(usageFile, String.raw`<?php
namespace Vendor\Module;
ProductTable::getList([]);
`, "utf8");

  const server = createMcpServer({ ...runtimePaths(dataDir, root), bitrixRoot: root });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_orm_search);
  assert.ok(tools.bitrix_orm_entity_map);
  assert.ok(tools.bitrix_orm_usage_search);
  await tools.bitrix_index_all.handler({});

  const searchResult = await tools.bitrix_orm_search.handler({ tableName: "vendor_product", kind: "bitrix", limit: 5 });
  const entities = JSON.parse(searchResult.content[0].text) as Array<{ className: string; tableName: string; fields: Array<{ name: string; type: string }>; references: Array<{ name: string; referenceClass: string }> }>;
  assert.equal(entities[0]?.className, "Vendor\\Module\\ProductTable");
  assert.equal(entities[0]?.tableName, "vendor_product");
  assert.equal(entities[0]?.fields[0]?.name, "ID");
  assert.equal(entities[0]?.references[0]?.referenceClass, "Vendor\\Module\\UserTable");

  const mapResult = await tools.bitrix_orm_entity_map.handler({ className: "Vendor\\Module\\ProductTable" });
  const maps = JSON.parse(mapResult.content[0].text) as Array<{ tableName: string }>;
  assert.equal(maps[0]?.tableName, "vendor_product");

  const usageResult = await tools.bitrix_orm_usage_search.handler({ entity: "Vendor\\Module\\ProductTable", method: "getList" });
  const usages = JSON.parse(usageResult.content[0].text) as Array<{ entity: string; method: string; usageKind: string }>;
  assert.equal(usages[0]?.entity, "Vendor\\Module\\ProductTable");
  assert.equal(usages[0]?.method, "getList");
  assert.equal(usages[0]?.usageKind, "datamanager");
});

test("MCP component tools are registered and return component context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-components-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-components-data-"));
  const templateDir = path.join(root, "local", "templates", "site", "components", "bitrix", "catalog.section", ".default");
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(root, "index.php"), String.raw`<?php
$APPLICATION->IncludeComponent("bitrix:catalog.section", "", ["IBLOCK_ID" => 7, "AJAX_MODE" => "N"]);
`, "utf8");
  await fs.writeFile(path.join(templateDir, "template.php"), "<?php\n", "utf8");
  await fs.writeFile(path.join(templateDir, "style.css"), ".x{}\n", "utf8");

  const paths = runtimePaths(dataDir, root);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_project.handler({});
  await tools.bitrix_index_template.handler({});

  const searchResult = await tools.bitrix_component_search.handler({ component: "bitrix:catalog.section", limit: 5 });
  const searchPayload = JSON.parse(searchResult.content[0].text) as Array<{ component: string; template: string }>;
  assert.equal(searchPayload[0]?.component, "bitrix:catalog.section");
  assert.equal(searchPayload[0]?.template, ".default");

  const contextResult = await tools.bitrix_component_context.handler({ component: "bitrix:catalog.section", includeAssets: true });
  const contextPayload = JSON.parse(contextResult.content[0].text) as { component: string; calls: unknown[]; templateFiles: Array<{ file: string }>; assets: Array<{ file: string }>; parameters: Array<{ name: string; value: unknown }> };
  assert.equal(contextPayload.component, "bitrix:catalog.section");
  assert.ok(contextPayload.calls.length >= 1);
  assert.ok(contextPayload.templateFiles.some((file) => file.file.endsWith("template.php")));
  assert.ok(contextPayload.assets.some((file) => file.file.endsWith("style.css")));
  assert.ok(contextPayload.parameters.some((param) => param.name === "IBLOCK_ID" && param.value === 7));
});

test("MCP bitrix_hlblock_usage_search is registered and searches indexed Highloadblock usages", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-hlblock-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-hlblock-root-"));
  await fs.writeFile(path.join(root, "index.php"), "<?php\nHighloadBlockTable::getById(3);\n", "utf8");
  const paths = runtimePaths(dataDir, root);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_hlblock_usage_search);
  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_hlblock_usage_search.handler({ hlblockId: "3", limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ hlblockId: string; api: string; file: string; line: number }>;
  assert.equal(compact[0]?.hlblockId, "3");
  assert.equal(compact[0]?.api, "HighloadBlockTable::getById");
  assert.equal(compact[0]?.file, "index.php");

  const fullResult = await tools.bitrix_hlblock_usage_search.handler({ api: "HighloadBlockTable::getById", format: "full" });
  const full = JSON.parse(fullResult.content[0].text) as Array<{ type: string; hlblockId: string }>;
  assert.equal(full[0]?.type, "hlblock_usage");
});

test("MCP bitrix_iblock_usage_search is registered and searches indexed IBlock usages", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-iblock-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-iblock-root-"));
  await fs.writeFile(path.join(root, "index.php"), "<?php\nCIBlockElement::GetList([], ['IBLOCK_ID' => CATALOG_IBLOCK_ID]);\n", "utf8");
  const paths = runtimePaths(dataDir, root);
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_iblock_usage_search);
  await tools.bitrix_index_project.handler({});
  const result = await tools.bitrix_iblock_usage_search.handler({ iblockId: "CATALOG_IBLOCK_ID", limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ iblockId: string; api: string; file: string; line: number }>;
  assert.equal(compact[0]?.iblockId, "CATALOG_IBLOCK_ID");
  assert.equal(compact[0]?.api, "CIBlockElement::GetList");
  assert.equal(compact[0]?.file, "index.php");

  const fullResult = await tools.bitrix_iblock_usage_search.handler({ api: "CIBlockElement::GetList", format: "full" });
  const full = JSON.parse(fullResult.content[0].text) as Array<{ type: string; iblockId: string }>;
  assert.equal(full[0]?.type, "iblock_usage");
});

test("MCP bitrix_option_search is registered and searches indexed options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-options-root-"));
  await fs.writeFile(path.join(root, "options.php"), "<?php\nuse Bitrix\\Main\\Config\\Option;\nOption::get('vendor.module', 'server_option');\nCOption::SetOptionString('vendor.module', 'server_set', 'Y');\n");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-options-"));
  const server = createMcpServer(runtimePaths(dataDir, root));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_option_search);
  await tools.bitrix_index_project.handler({});

  const compactResult = await tools.bitrix_option_search.handler({ module: "vendor.module", name: "server_option" });
  const compact = JSON.parse(compactResult.content[0].text) as Array<{ type: string; module: string; name: string; operation: string; api: string }>;
  assert.equal(compact[0]?.type, "option");
  assert.equal(compact[0]?.module, "vendor.module");
  assert.equal(compact[0]?.name, "server_option");
  assert.equal(compact[0]?.operation, "get");
  assert.equal(compact[0]?.api, "Option::get");

  const fullResult = await tools.bitrix_option_search.handler({ operation: "set", format: "full" });
  const full = JSON.parse(fullResult.content[0].text) as Array<{ type: string; name: string; operation: string; api: string }>;
  assert.equal(full[0]?.type, "option");
  assert.equal(full[0]?.name, "server_set");
  assert.equal(full[0]?.operation, "set");
  assert.equal(full[0]?.api, "COption::SetOptionString");
});

test("MCP bitrix_inheritance_search finds extends, implements, and trait usage relations", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-inheritance-"));
  const file = path.join(fixtureRoot, "local/modules/vendor.module/lib/inheritance.php");
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: fixtureRoot,
    kind: "project",
    files: [{
      path: file,
      relativePath: "local/modules/vendor.module/lib/inheritance.php",
      kind: "project",
      size: 1,
      mtimeMs: 1,
      language: "php",
      symbols: [{
        type: "class",
        name: "Vendor\\Module\\Service",
        fullyQualifiedName: "Vendor\\Module\\Service",
        module: "vendor.module",
        file,
        line: 10,
        lineEnd: 30,
        extends: "Bitrix\\Main\\ORM\\Data\\DataManager",
        implements: ["Vendor\\Module\\Contract\\ServiceInterface"],
        traits: ["Vendor\\Module\\Support\\SomeTrait"],
        signature: "class Service extends DataManager implements ServiceInterface"
      }]
    }]
  }, { force: true });

  const server = createMcpServer(runtimePaths(dataDir));
  const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.bitrix_inheritance_search;

  const extendsResult = JSON.parse((await tool.handler({ target: "\\Bitrix\\Main\\ORM\\Data\\DataManager", relation: "extends" })).content[0].text) as { count: number; results: Array<{ className: string; relation: string; targetName: string }> };
  assert.equal(extendsResult.count, 1);
  assert.equal(extendsResult.results[0]?.className, "Vendor\\Module\\Service");
  assert.equal(extendsResult.results[0]?.relation, "extends");

  const implementsResult = JSON.parse((await tool.handler({ target: "ServiceInterface", relation: "implements" })).content[0].text) as { count: number; results: Array<{ className: string; relation: string; targetName: string }> };
  assert.equal(implementsResult.count, 1);
  assert.equal(implementsResult.results[0]?.targetName, "Vendor\\Module\\Contract\\ServiceInterface");

  const traitResult = JSON.parse((await tool.handler({ target: "SomeTrait", relation: "uses_trait" })).content[0].text) as { count: number; results: Array<{ className: string; relation: string; targetName: string }> };
  assert.equal(traitResult.count, 1);
  assert.equal(traitResult.results[0]?.targetName, "Vendor\\Module\\Support\\SomeTrait");
});

test("MCP bitrix_autoload_search is registered and returns compact Composer records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-autoload-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-autoload-data-"));
  await fs.mkdir(path.join(root, "local", "php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local", "php_interface", "init.php"), "<?php\n", "utf8");
  await fs.writeFile(path.join(root, "composer.json"), JSON.stringify({
    autoload: { "psr-4": { "Vendor\\Module\\": "local/modules/vendor.module/lib" }, files: ["local/php_interface/functions.php"] },
    require: { "bitrix/framework": "^1.0" },
    "require-dev": { "phpunit/phpunit": "^11.0" }
  }), "utf8");
  const server = createMcpServer(runtimePaths(dataDir, root));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_autoload_search);
  await tools.bitrix_index_project.handler({});
  const psr4Result = await tools.bitrix_autoload_search.handler({ namespace: "Vendor\\Module\\" });
  const psr4 = JSON.parse(psr4Result.content[0].text) as Array<{ type: string; namespace: string; paths: string[] }>;
  assert.deepEqual(psr4[0], { type: "psr-4", namespace: "Vendor\\Module\\", paths: ["local/modules/vendor.module/lib"], sourceFile: "composer.json" });

  const bootstrapResult = await tools.bitrix_autoload_search.handler({ type: "bootstrap" });
  const bootstraps = JSON.parse(bootstrapResult.content[0].text) as Array<{ type: string; file: string }>;
  assert.equal(bootstraps[0]?.file, "local/php_interface/init.php");

  const depResult = await tools.bitrix_autoload_search.handler({ package: "phpunit/phpunit" });
  const deps = JSON.parse(depResult.content[0].text) as Array<{ type: string; package: string; dev: boolean }>;
  assert.equal(deps[0]?.type, "dev_dependency");
  assert.equal(deps[0]?.dev, true);
});

test("MCP bitrix_project_overview returns compact summary and warnings", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-overview-empty-"));
  const server = createMcpServer(runtimePaths(dataDir));
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  assert.ok(tools.bitrix_project_overview);
  const emptyResult = await tools.bitrix_project_overview.handler({});
  const empty = JSON.parse(emptyResult.content[0].text) as { summary: { files: number; relations: number }; warnings: string[]; indexes: Record<string, Record<string, unknown>> };
  assert.equal(empty.summary.files, 0);
  assert.equal(empty.summary.relations, 0);
  assert.ok(empty.warnings.includes("project index missing"));
  assert.ok(empty.warnings.includes("no relations found"));
  assert.deepEqual(empty.indexes.project, {});
});

test("MCP bitrix_project_overview summarizes indexed Bitrix entities", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-server-overview-full-"));
  const server = createMcpServer({ ...runtimePaths(dataDir), bitrixRoot: fixtureRoot });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

  await tools.bitrix_index_all.handler({});
  const agentFile = path.join(fixtureRoot, "local", "modules", "vendor.module", "install", "agent.php");
  await writeIndexToSqlite(sqlitePath(dataDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: fixtureRoot,
    kind: "install",
    files: [{
      path: agentFile,
      relativePath: slashPath("local/modules/vendor.module/install/agent.php"),
      kind: "install",
      size: 1,
      mtimeMs: 1,
      language: "php",
      symbols: [
        { type: "agent", name: "\\Vendor\\Module\\Agent::run", module: "vendor.module", file: agentFile, line: 1, periodic: "N", interval: 86400 },
        { type: "mail_event", name: "SALE_NEW_ORDER", eventName: "SALE_NEW_ORDER", api: "Event::send", file: agentFile, line: 2 }
      ],
      ormEntities: [{ type: "orm_entity", className: "ProductTable", fullyQualifiedName: "Vendor\\Module\\ProductTable", namespace: "Vendor\\Module", tableName: "vendor_product", file: agentFile, line: 3, fields: [], references: [] }]
    }]
  });
  const result = await tools.bitrix_project_overview.handler({ includeTopFiles: true });
  const overview = JSON.parse(result.content[0].text) as { summary: { symbols: number; events: number; relations: number; components: number; agents: number; mailEvents: number; ormEntities: number }; components: unknown[]; agents: unknown[]; mailEvents: unknown[]; ormEntities: unknown[]; topFiles: unknown[]; warnings: string[] };
  assert.ok(overview.summary.symbols > 0);
  assert.ok(overview.summary.relations > 0);
  assert.ok(overview.summary.components > 0);
  assert.ok(overview.summary.agents > 0);
  assert.ok(overview.summary.mailEvents > 0);
  assert.ok(overview.summary.ormEntities > 0);
  assert.ok(overview.components.length > 0);
  assert.ok(overview.agents.length > 0);
  assert.ok(overview.mailEvents.length > 0);
  assert.ok(overview.ormEntities.length > 0);
  assert.ok(overview.topFiles.length > 0);
  assert.ok(!overview.warnings.includes("no relations found"));
});
