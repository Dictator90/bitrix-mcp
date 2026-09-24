import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, LEGACY_TOOLS_ENV, SERVER_INSTRUCTIONS, type CreateMcpServerOptions } from "../src/mcp/server.js";
import { ENTITY_TYPES } from "../src/mcp/entitySearch.js";
import { decodeCursor, encodeCursor, MAX_PAGE_WINDOW, pageRequest, paginate } from "../src/mcp/envelope.js";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { writeBitrixRelations } from "../src/indexer/sqliteStore.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

/** Workspace of the shared indexed fixture: the fixture project plus a module include. */
let workspaceRoot = fixtureRoot;

function runtimePaths(dataDir: string): RuntimePaths {
  return {
    workspaceRoot,
    dataDir,
    docsDir: path.join(workspaceRoot, "docs"),
    docsPaths: [path.join(workspaceRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };
}

interface Envelope {
  count: number;
  total?: number;
  truncated: boolean;
  nextCursor?: string;
  results: Array<Record<string, unknown>>;
  entity?: string;
  warnings?: string[];
}

async function connect(dataDir: string, options: CreateMcpServerOptions = {}): Promise<Client> {
  const server = createMcpServer(runtimePaths(dataDir), options);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ structured?: Envelope; text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  return { structured: result.structuredContent as Envelope | undefined, text, isError: result.isError === true };
}

let indexedDataDir: string | undefined;

/** One indexed fixture project (project + template scopes) shared by the read-only tests. */
async function indexedFixture(): Promise<string> {
  if (indexedDataDir) return indexedDataDir;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-root-"));
  await fs.cp(fixtureRoot, root, { recursive: true });
  await fs.mkdir(path.join(root, "local/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "local/php_interface/init.php"), "<?php\n\\Bitrix\\Main\\Loader::includeModule('iblock');\n", "utf8");
  workspaceRoot = root;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-"));
  const client = await connect(dataDir);
  try {
    for (const scope of ["project", "template"]) {
      const result = await call(client, "bitrix_index", { scope });
      assert.equal(result.isError, false, result.text);
    }
  } finally {
    await client.close();
  }
  indexedDataDir = dataDir;
  return dataDir;
}

const DEFAULT_TOOLS = [
  "bitrix_component_context", "bitrix_detect_changes", "bitrix_docs_for_symbol", "bitrix_docs_search", "bitrix_entity_search",
  "bitrix_event_search", "bitrix_explain_api_usage", "bitrix_graph_neighbors", "bitrix_graph_traverse", "bitrix_impact_radius",
  "bitrix_index", "bitrix_index_status", "bitrix_liveapi_search", "bitrix_orm_entity_map", "bitrix_project_overview",
  "bitrix_read_file_context", "bitrix_read_symbol_context"
];

test("server advertises instructions with the recommended workflow", async () => {
  const client = await connect(await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-instr-")));
  try {
    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.match(instructions, /bitrix_index_status.*bitrix_project_overview.*bitrix_entity_search.*bitrix_read_symbol_context/s);
    assert.ok(client.getServerCapabilities()?.prompts);
    assert.ok(client.getServerCapabilities()?.completions);
  } finally {
    await client.close();
  }
});

test("tools/list has the consolidated surface with titles, annotations, described params, and output schemas", async () => {
  const client = await connect(await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-list-")));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), DEFAULT_TOOLS);
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has a title`);
      assert.ok(tool.annotations, `${tool.name} has annotations`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      for (const [param, schema] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) {
        assert.ok(schema.description, `${tool.name}.${param} has a description`);
      }
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["bitrix_liveapi_search", "bitrix_event_search", "bitrix_entity_search", "bitrix_docs_search", "bitrix_docs_for_symbol", "bitrix_orm_entity_map"]) {
      const outputSchema = byName.get(name)?.outputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
      assert.ok(outputSchema, `${name} has an outputSchema`);
      assert.deepEqual(Object.keys(outputSchema.properties ?? {}).slice(0, 5), ["count", "total", "truncated", "nextCursor", "results"]);
      assert.deepEqual(outputSchema.required?.sort(), ["count", "results", "truncated"]);
    }
    const entityEnum = (byName.get("bitrix_entity_search")?.inputSchema.properties as Record<string, { enum?: string[] }>).entity.enum;
    assert.deepEqual(entityEnum, [...ENTITY_TYPES]);
    const scopeEnum = (byName.get("bitrix_index")?.inputSchema.properties as Record<string, { enum?: string[] }>).scope.enum;
    assert.deepEqual(scopeEnum, ["project", "template", "bitrix", "install", "docs", "all"]);
    assert.equal(byName.get("bitrix_index")?.annotations?.readOnlyHint, false);
    assert.equal(byName.get("bitrix_entity_search")?.annotations?.readOnlyHint, true);
  } finally {
    await client.close();
  }
});

test("legacy tool names are registered only with BITRIX_MCP_LEGACY_TOOLS=1 and forward to the new tools", async () => {
  const dataDir = await indexedFixture();
  const plain = await connect(dataDir);
  try {
    const names = (await plain.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes("bitrix_agent_search"), false);
    assert.equal(names.includes("bitrix_index_project"), false);
  } finally {
    await plain.close();
  }

  const previous = process.env[LEGACY_TOOLS_ENV];
  process.env[LEGACY_TOOLS_ENV] = "1";
  let legacy: Client;
  try {
    legacy = await connect(dataDir);
  } finally {
    if (previous === undefined) delete process.env[LEGACY_TOOLS_ENV];
    else process.env[LEGACY_TOOLS_ENV] = previous;
  }
  try {
    const { tools } = await legacy.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["bitrix_agent_search", "bitrix_relation_search", "bitrix_inheritance_search", "bitrix_orm_usage_search", "bitrix_autoload_search", "bitrix_index_project", "bitrix_index_template", "bitrix_index_all", "bitrix_index_docs"]) {
      assert.ok(names.includes(name), `${name} is registered`);
    }
    assert.equal(tools.length, DEFAULT_TOOLS.length + 16);
    assert.match(tools.find((tool) => tool.name === "bitrix_agent_search")?.description ?? "", /Deprecated: use bitrix_entity_search with entity=agent/);

    const moduleUsages = await call(legacy, "bitrix_module_usage_search", { module: "iblock" });
    assert.equal(moduleUsages.structured?.entity, "module_usage");
    assert.ok((moduleUsages.structured?.count ?? 0) > 0);

    const autoload = await call(legacy, "bitrix_autoload_search", { type: "psr-4" });
    assert.equal(autoload.structured?.entity, "autoload");
    assert.equal(autoload.structured?.warnings, undefined);
  } finally {
    await legacy.close();
  }
});

test("bitrix_entity_search dispatches every entity and returns the envelope", async () => {
  const client = await connect(await indexedFixture());
  try {
    const filters: Record<string, Record<string, unknown>> = {
      inheritance: { target: "DataManager" },
      module_usage: { module: "iblock" },
      mail_event: { eventName: "SALE_NEW_ORDER", includeHandlers: true }
    };
    for (const entity of ENTITY_TYPES) {
      const result = await call(client, "bitrix_entity_search", { entity, ...(filters[entity] ?? {}) });
      assert.equal(result.isError, false, `${entity}: ${result.text}`);
      const envelope = result.structured;
      assert.equal(envelope?.entity, entity);
      assert.equal(typeof envelope?.count, "number");
      assert.equal(typeof envelope?.truncated, "boolean");
      assert.ok(Array.isArray(envelope?.results));
      assert.deepEqual(JSON.parse(result.text), envelope, "text content mirrors structuredContent");
      assert.doesNotMatch(result.text, /\n/, "text content is compact JSON");
    }

    const usages = await call(client, "bitrix_entity_search", { entity: "module_usage", module: "iblock" });
    assert.ok((usages.structured?.count ?? 0) > 0);
    assert.equal(usages.structured?.results[0]?.module, "iblock");

    const ignored = await call(client, "bitrix_entity_search", { entity: "agent", iblockId: "5", tableName: "b_user" });
    assert.match(ignored.structured?.warnings?.[0] ?? "", /Ignored filters for entity=agent: iblockId, tableName/);

    const missingTarget = await call(client, "bitrix_entity_search", { entity: "inheritance" });
    assert.equal(missingTarget.isError, true);
    assert.match(missingTarget.text, /requires target/);

    const invalid = await call(client, "bitrix_entity_search", { entity: "not_an_entity" });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});

test("cursor pagination distinguishes a full page from the end and round-trips to the last page", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-paging-"));
  await writeBitrixRelations(sqlitePath(dataDir), Array.from({ length: 5 }, (_, index) => ({
    sourceType: "file",
    sourceName: `local/page_${index}.php`,
    targetType: "module",
    targetName: "paging.module",
    relationType: "includes_module",
    file: `local/page_${index}.php`,
    line: index + 1,
    kind: "project"
  })));
  const client = await connect(dataDir);
  try {
    const seen: string[] = [];
    let cursor: string | undefined;
    const pages: Envelope[] = [];
    do {
      const result = await call(client, "bitrix_entity_search", { entity: "relation", targetName: "paging.module", limit: 2, ...(cursor ? { cursor } : {}) });
      assert.equal(result.isError, false, result.text);
      const page = result.structured as Envelope;
      pages.push(page);
      seen.push(...page.results.map((row) => String(row.source)));
      cursor = page.nextCursor;
    } while (cursor && pages.length < 10);

    assert.deepEqual(pages.map((page) => page.count), [2, 2, 1]);
    assert.deepEqual(pages.map((page) => page.truncated), [true, true, false]);
    assert.equal(pages[0].total, undefined);
    assert.equal(pages[2].total, 5);
    assert.equal(pages[2].nextCursor, undefined);
    assert.equal(new Set(seen).size, 5, "pages do not overlap");

    // Exactly `limit` rows left: the page is full but it is the end (limit + 1 was fetched).
    const exact = await call(client, "bitrix_entity_search", { entity: "relation", targetName: "paging.module", limit: 5 });
    assert.equal(exact.structured?.count, 5);
    assert.equal(exact.structured?.truncated, false);
    assert.equal(exact.structured?.total, 5);

    const bad = await call(client, "bitrix_entity_search", { entity: "relation", cursor: "not-a-cursor" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Invalid cursor/);
  } finally {
    await client.close();
  }
});

test("bitrix_liveapi_search pages keep a stable ranking", async () => {
  const client = await connect(await indexedFixture());
  try {
    const all = await call(client, "bitrix_liveapi_search", { query: "demo", limit: 50 });
    const total = all.structured?.count ?? 0;
    assert.ok(total >= 2, "fixture has several demo symbols");
    const first = await call(client, "bitrix_liveapi_search", { query: "demo", limit: 1 });
    assert.equal(first.structured?.truncated, true);
    assert.ok(first.structured?.nextCursor);
    const second = await call(client, "bitrix_liveapi_search", { query: "demo", limit: 1, cursor: first.structured?.nextCursor });
    assert.deepEqual([...(first.structured?.results ?? []), ...(second.structured?.results ?? [])], all.structured?.results.slice(0, 2));
  } finally {
    await client.close();
  }
});

test("envelope helpers cap the pagination window", () => {
  assert.equal(decodeCursor(undefined), 0);
  assert.equal(decodeCursor(encodeCursor(40)), 40);
  assert.throws(() => decodeCursor(encodeCursor(MAX_PAGE_WINDOW)), /Invalid cursor/);
  const rows = Array.from({ length: MAX_PAGE_WINDOW }, (_, index) => ({ index }));
  const page = pageRequest(50, 480);
  assert.equal(page.fetch, MAX_PAGE_WINDOW);
  const envelope = paginate(rows, page);
  assert.equal(envelope.count, 20);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.nextCursor, undefined);
  assert.match(envelope.warnings?.[0] ?? "", /Pagination window/);
});

test("prompts are listed and render workflow templates", async () => {
  const client = await connect(await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-prompts-")));
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["explain-api", "review-changes", "trace-event"]);

    const review = await client.getPrompt({ name: "review-changes", arguments: { base: "origin/main" } });
    const reviewText = (review.messages[0].content as { text: string }).text;
    assert.match(reviewText, /bitrix_detect_changes with base="origin\/main"/);
    assert.match(reviewText, /bitrix_impact_radius/);

    const defaultReview = await client.getPrompt({ name: "review-changes", arguments: {} });
    assert.match((defaultReview.messages[0].content as { text: string }).text, /HEAD~1/);

    const explain = await client.getPrompt({ name: "explain-api", arguments: { symbol: "CIBlockElement::GetList" } });
    assert.match((explain.messages[0].content as { text: string }).text, /bitrix_explain_api_usage with query="CIBlockElement::GetList"/);

    const trace = await client.getPrompt({ name: "trace-event", arguments: { module: "main", event: "OnBeforeProlog" } });
    assert.match((trace.messages[0].content as { text: string }).text, /nodeName="main:OnBeforeProlog"/);
  } finally {
    await client.close();
  }
});

test("prompt arguments complete from the index", async () => {
  const client = await connect(await indexedFixture());
  try {
    const modules = await client.complete({ ref: { type: "ref/prompt", name: "trace-event" }, argument: { name: "module", value: "" } });
    assert.ok(modules.completion.values.includes("main"), JSON.stringify(modules.completion.values));
    assert.ok(modules.completion.values.includes("iblock"), JSON.stringify(modules.completion.values));

    const events = await client.complete({ ref: { type: "ref/prompt", name: "trace-event" }, argument: { name: "event", value: "onbefore" }, context: { arguments: { module: "main" } } });
    assert.ok(events.completion.values.includes("OnBeforeProlog"), JSON.stringify(events.completion.values));

    const symbols = await client.complete({ ref: { type: "ref/prompt", name: "explain-api" }, argument: { name: "symbol", value: "demo_" } });
    assert.ok(symbols.completion.values.includes("demo_helper"), JSON.stringify(symbols.completion.values));

    const refs = await client.complete({ ref: { type: "ref/prompt", name: "review-changes" }, argument: { name: "base", value: "origin/" } });
    assert.deepEqual(refs.completion.values, ["origin/main", "origin/master"]);
  } finally {
    await client.close();
  }
});

test("completions return nothing without an index", async () => {
  const client = await connect(await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-protocol-empty-")));
  try {
    const modules = await client.complete({ ref: { type: "ref/prompt", name: "trace-event" }, argument: { name: "module", value: "ma" } });
    assert.deepEqual(modules.completion.values, []);
  } finally {
    await client.close();
  }
});
