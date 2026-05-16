import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { readIndexFromSqlite, writeBitrixRelations } from "../src/indexer/sqliteStore.js";
import { addPathDocSource } from "../src/resources/docs.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

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
  assert.ok(results[0]?.file);
  assert.ok(results[0]?.line);

  const eventResult = await tools.bitrix_event_search.handler({ query: "Demo", module: "main", limit: 5 });
  const eventResults = JSON.parse(eventResult.content[0].text) as Array<{ type: string; name: string; module: string; file: string; line: number }>;

  assert.equal(eventResults[0]?.type, "event");
  assert.equal(eventResults[0]?.name, "OnBeforeProlog");
  assert.equal(eventResults[0]?.module, "main");

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
    file: path.join("local", "php_interface", "init.php"),
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
  const result = await tools.bitrix_agent_search.handler({ query: "Agent::run", module: "vendor.module", kind: "install", limit: 5 });
  const compact = JSON.parse(result.content[0].text) as Array<{ name: string; module: string; periodic: string; interval: number; kind: string; file: string; line: number; signature: string }>;

  assert.deepEqual(compact[0], {
    name: "\\Vendor\\Module\\Agent::run",
    module: "vendor.module",
    periodic: "N",
    interval: 86400,
    kind: "install",
    file: path.join("local", "modules", "vendor.module", "install", "index.php"),
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
  assert.equal(compact[0]?.file, path.join("local", "php_interface", "mail.php"));
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
