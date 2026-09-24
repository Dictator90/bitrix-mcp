import { McpServer, ResourceTemplate, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { readPackageVersion } from "../config/version.js";
import { resolveRuntimePaths, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { readIndexStatus } from "../indexer/actions.js";
import { searchSymbolsForContext } from "../indexer/sqliteStore.js";
import { ALLOW_SECRET_FILES_ENV, isSecretFile, secretFilesAllowed } from "../config/secrets.js";
import { detectLanguage } from "../indexer/language.js";
import { listDocResources, readDocResource } from "../resources/docs.js";
import { confirmDangerousCall, toolAnnotations } from "./annotations.js";
import { closeWorkerPools, runWorkerTask, withMcpToolGuard, type McpToolGuardOptions } from "./toolGuards.js";
import { EmbeddingsClient } from "../search/embeddingsClient.js";
import { formatSemanticDocSearchResults } from "./format.js";
import { cursorSchema, decodeCursor, jsonResult, resultEnvelopeShape, structuredResult } from "./envelope.js";
import { entitySearchShape, type EntitySearchInput } from "./entitySearch.js";
import { formatSchema, KIND_DESCRIPTION, NODE_TYPES_DESCRIPTION, RELATION_TYPES_DESCRIPTION, searchFormatShape, searchKindSchema } from "./schemas.js";
import { indexToolShape, registerLegacyTools, type IndexToolArgs } from "./legacyTools.js";
import { registerPrompts } from "./prompts.js";
import type { SymbolRecord } from "../types.js";

const ALLOW_OUTSIDE_WORKSPACE_ENV = "BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE";

function allowOutsideWorkspace(): boolean {
  return process.env[ALLOW_OUTSIDE_WORKSPACE_ENV] === "1";
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathRestrictionError(toolName: string, parameterName: string, received: string | undefined, resolved: string, workspaceRoot: string): Error {
  const value = received ?? "<default workspaceRoot>";
  return new Error(`MCP path restriction: ${toolName} parameter "${parameterName}" must resolve inside workspaceRoot (${workspaceRoot}). Received ${value}; resolved to ${resolved}. Set ${ALLOW_OUTSIDE_WORKSPACE_ENV}=1 to explicitly allow indexing outside the workspace.`);
}

function normalizeProjectRoot(paths: RuntimePaths, root: string | undefined, toolName: string): string {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  const resolvedRoot = path.resolve(root ?? workspaceRoot);
  if (!allowOutsideWorkspace() && !isInsideWorkspace(workspaceRoot, resolvedRoot)) {
    throw pathRestrictionError(toolName, "root", root, resolvedRoot, workspaceRoot);
  }
  return resolvedRoot;
}

function containsParentSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/u).includes("..");
}

function normalizeTemplateRoot(paths: RuntimePaths, templatePath: string | undefined, toolName: string): string {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  if (!templatePath) return workspaceRoot;

  const resolvedRoot = path.resolve(workspaceRoot, templatePath);
  if (!allowOutsideWorkspace()) {
    if (path.isAbsolute(templatePath)) {
      throw new Error(`MCP path restriction: ${toolName} parameter "templatePath" must be relative to workspaceRoot (${workspaceRoot}); absolute paths are disabled by default. Received ${templatePath}. Set ${ALLOW_OUTSIDE_WORKSPACE_ENV}=1 to explicitly allow indexing outside the workspace.`);
    }
    if (containsParentSegment(templatePath)) {
      throw new Error(`MCP path restriction: ${toolName} parameter "templatePath" must not contain ".." path segments by default. Received ${templatePath}; resolved to ${resolvedRoot}. Set ${ALLOW_OUTSIDE_WORKSPACE_ENV}=1 to explicitly allow indexing outside the workspace.`);
    }
    if (!isInsideWorkspace(workspaceRoot, resolvedRoot)) {
      throw pathRestrictionError(toolName, "templatePath", templatePath, resolvedRoot, workspaceRoot);
    }
  }
  return resolvedRoot;
}

type ReadSymbolContextResult = {
  ambiguous: boolean;
  query: {
    name: string;
    type?: string;
    kind?: string | string[];
    file?: string;
  };
  candidates?: Array<Record<string, unknown>>;
  symbol?: Record<string, unknown>;
  context?: FileContextResult;
  message?: string;
};

function compactSymbolCandidate(symbol: SymbolRecord): Record<string, unknown> {
  return {
    type: symbol.type,
    name: symbol.name,
    className: symbol.className,
    module: symbol.module,
    kind: symbol.kind,
    file: symbol.relativeFile ?? symbol.file,
    line: symbol.line,
    lineEnd: symbol.lineEnd,
    signature: symbol.signature
  };
}

function symbolForFormat(symbol: SymbolRecord, format: "compact" | "full" | undefined): Record<string, unknown> {
  return format === "full" ? { ...symbol } : compactSymbolCandidate(symbol);
}

interface FileContextResult {
  metadata: {
    absolutePath: string;
    relativePath: string;
    language: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
  };
  numberedLines: string;
}

function normalizeAllowRoot(root: string): string {
  return path.resolve(root);
}

function resolveRequestedFilePath(paths: RuntimePaths, requestedFile: string): string {
  const workspaceRoot = normalizeAllowRoot(paths.workspaceRoot);
  return path.resolve(path.isAbsolute(requestedFile) ? requestedFile : path.join(workspaceRoot, requestedFile));
}

function readFileRestrictionError(received: string, resolved: string, allowedRoots: string[]): Error {
  return new Error(`MCP path restriction: bitrix_read_file_context parameter "file" must resolve inside one of the allowed roots (${allowedRoots.join(", ")}). Received ${received}; resolved to ${resolved}.`);
}

async function assertFileInsideReadAllowlist(paths: RuntimePaths, requestedFile: string): Promise<{ absolutePath: string; relativePath: string }> {
  const allowedRoots = [paths.workspaceRoot, paths.dataDir].map(normalizeAllowRoot);
  const resolvedPath = resolveRequestedFilePath(paths, requestedFile);

  let realFilePath: string;
  try {
    realFilePath = await fs.realpath(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`MCP file read failed: ${resolvedPath} does not exist.`);
    }
    throw error;
  }

  const realAllowedRoots = await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await fs.realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return root;
      }
      throw error;
    }
  }));

  const matchingRoot = realAllowedRoots.find((root) => isInsideWorkspace(root, realFilePath));
  if (!matchingRoot) {
    throw readFileRestrictionError(requestedFile, realFilePath, realAllowedRoots);
  }

  const workspaceRoot = realAllowedRoots[0] ?? allowedRoots[0];
  const relativePath = (isInsideWorkspace(workspaceRoot, realFilePath)
    ? path.relative(workspaceRoot, realFilePath)
    : path.relative(matchingRoot, realFilePath)).replace(/\\/gu, "/");

  if (!secretFilesAllowed() && isSecretFile(relativePath)) {
    throw new Error(`MCP secret-file restriction: ${relativePath} may contain credentials or bulk data (DB settings, env/VCS/SSH files, keys, dumps, backups) and is not returned to the client. Set ${ALLOW_SECRET_FILES_ENV}=1 to allow it on a trusted machine.`);
  }

  return { absolutePath: realFilePath, relativePath };
}

const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;

/** Reads a text file for a context excerpt, refusing oversized and binary files instead of loading them whole. */
async function readContextFile(absolutePath: string, relativePath: string): Promise<string> {
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`MCP file read refused: ${relativePath} is ${stat.size} bytes; context reads are limited to ${MAX_CONTEXT_FILE_BYTES} bytes.`);
  }
  const contents = await fs.readFile(absolutePath, "utf8");
  if (contents.slice(0, 8192).includes("\u0000")) {
    throw new Error(`MCP file read refused: ${relativePath} looks like a binary file.`);
  }
  return contents;
}

function buildFileContext(contents: string, absolutePath: string, relativePath: string, line: number, before: number, after: number, maxChars: number): FileContextResult {
  const normalizedContents = contents.replace(/\r\n?/gu, "\n");
  const lines = normalizedContents.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const targetLine = Math.min(Math.max(line, 1), Math.max(totalLines, 1));
  const startLine = Math.max(1, targetLine - before);
  const endLine = Math.min(totalLines, targetLine + after);
  const lineNumberWidth = String(endLine).length;
  const selectedLines: string[] = [];
  let usedChars = 0;
  let truncated = false;

  for (let currentLine = startLine; currentLine <= endLine; currentLine += 1) {
    const numberedLine = `${String(currentLine).padStart(lineNumberWidth, " ")}: ${lines[currentLine - 1] ?? ""}`;
    const separatorChars = selectedLines.length === 0 ? 0 : 1;
    if (usedChars + separatorChars + numberedLine.length > maxChars) {
      truncated = true;
      break;
    }
    selectedLines.push(numberedLine);
    usedChars += separatorChars + numberedLine.length;
  }

  return {
    metadata: {
      absolutePath,
      relativePath,
      language: detectLanguage(absolutePath),
      startLine,
      endLine: startLine + selectedLines.length - 1,
      totalLines,
      truncated
    },
    numberedLines: selectedLines.join("\n")
  };
}

const symbolContextTypeSchema = z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant"]);
const changedFileKindSchema = z.enum(["project", "template", "component", "bitrix", "install", "docs", "asset", "unknown"]);
const changedFileKindFilterSchema = z.union([changedFileKindSchema, z.array(changedFileKindSchema).min(1).max(8)]);
const graphDirectionSchema = z.enum(["out", "in", "both"]).optional().describe("Edge direction: out (outgoing edges), in (incoming edges), or both; default out.");
const maxEdgesPerNodeSchema = z.number().int().min(1).max(1000).optional().describe("Maximum edges read per node and direction (hub protection); defaults to limit. Capped nodes are listed in truncatedNodes.");

/** Environment switch that re-registers the pre-0.9 tool names as thin wrappers (one-release compatibility). */
export const LEGACY_TOOLS_ENV = "BITRIX_MCP_LEGACY_TOOLS";

export function legacyToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LEGACY_TOOLS_ENV] === "1";
}

export const SERVER_INSTRUCTIONS = [
  "bitrix-mcp indexes a 1C-Bitrix project (project/template code, Bitrix core, docs) into local SQLite. Treat its results as the primary source of truth; manual grep is a fallback when a result is empty or the index is stale.",
  "Workflow: 1) bitrix_index_status (freshness; run bitrix_index when empty/stale) → 2) bitrix_project_overview → 3) search: bitrix_liveapi_search (symbols), bitrix_event_search (handlers), bitrix_entity_search (agents, mail events, components, modules, iblock/hlblock, options, ORM, autoload, relations, inheritance), bitrix_docs_search → 4) read context: bitrix_read_symbol_context / bitrix_read_file_context.",
  "Reviews: bitrix_detect_changes, then bitrix_impact_radius. Dependencies: bitrix_graph_neighbors / bitrix_graph_traverse.",
  "Search results are envelopes {count, total?, truncated, nextCursor?, results}; pass nextCursor as cursor for the next page."
].join("\n");

export interface CreateMcpServerOptions {
  /** Register the pre-0.9 tool names; defaults to BITRIX_MCP_LEGACY_TOOLS=1. */
  legacyTools?: boolean;
}

export function createMcpServer(paths: RuntimePaths = resolveRuntimePaths(), options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "bitrix-mcp", version: readPackageVersion() }, { instructions: SERVER_INSTRUCTIONS });
  const dbFile = sqlitePath(paths.dataDir);

  const runIndex = (toolName: string, args: IndexToolArgs, extra?: McpToolGuardOptions): Promise<CallToolResult> => {
    switch (args.scope) {
      case "project":
        return runWorkerTask(toolName, { name: "indexProject", paths, root: normalizeProjectRoot(paths, args.root, toolName) }, extra);
      case "template":
        return runWorkerTask(toolName, { name: "indexTemplate", paths, templatePath: normalizeTemplateRoot(paths, args.templatePath ?? args.root, toolName) }, extra);
      case "bitrix":
        return runWorkerTask(toolName, { name: "indexBitrix", paths, modules: args.modules }, extra);
      case "install":
        return runWorkerTask(toolName, { name: "indexInstall", paths }, extra);
      case "docs":
        return runWorkerTask(toolName, { name: "indexDocs", paths }, extra);
      case "all":
        return runWorkerTask(toolName, { name: "indexAll", paths, includeInstall: args.includeInstall }, extra);
    }
  };

  const runEntity = (toolName: string, input: EntitySearchInput, extra?: McpToolGuardOptions): Promise<CallToolResult> => {
    const { cursor, ...query } = input;
    return runWorkerTask(toolName, { name: "entitySearch", paths, query: { ...query, offset: decodeCursor(cursor) } }, extra);
  };

  const tool = <InputArgs extends ZodRawShape, OutputArgs extends ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: InputArgs; outputSchema?: OutputArgs },
    handler: ToolCallback<InputArgs>
  ) => server.registerTool(name, { ...config, annotations: toolAnnotations(name) }, handler);

  tool(
    "bitrix_index_status",
    {
      title: "Index status",
      description: "Show the SQLite DB path and index counters (files, symbols, events, docs, relations) and the last index time per scope. Call first to check freshness.",
      inputSchema: {}
    },
    async (_args, extra) => withMcpToolGuard("bitrix_index_status", async () => jsonResult(await readIndexStatus(paths)), extra)
  );

  tool(
    "bitrix_project_overview",
    {
      title: "Project overview",
      description: "Compact project overview: index status, counters, top modules/components/events/ORM/agents/mail events, autoload coverage, and warnings. Call before large tasks, after bitrix_index_status.",
      inputSchema: {
        includeTopFiles: z.boolean().optional().describe("Include files with the most symbols; default false."),
        includeModules: z.boolean().optional().describe("Include top modules; default true."),
        includeComponents: z.boolean().optional().describe("Include top components; default true."),
        includeEvents: z.boolean().optional().describe("Include top events; default true."),
        includeOrm: z.boolean().optional().describe("Include ORM entities; default true."),
        includeAgents: z.boolean().optional().describe("Include agents; default true."),
        includeMailEvents: z.boolean().optional().describe("Include mail events; default true."),
        includeWarnings: z.boolean().optional().describe("Include index/autoload warnings; default true."),
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_project_overview", { name: "projectOverview", paths, query }, extra)
  );

  tool(
    "bitrix_index",
    {
      title: "Build index",
      description: "Index Bitrix sources into the local SQLite index. scope: project (workspace code), template (templates/components; templatePath narrows it), bitrix (core modules, needs the Bitrix root), install (module install/ assets), docs (registered documentation sources; may git clone/pull), all (project + template + bitrix + docs, plus install when includeInstall). Incremental: unchanged files are skipped. Long-running; reports progress.",
      inputSchema: indexToolShape
    },
    async (args, extra) => runIndex("bitrix_index", args, extra)
  );

  tool(
    "bitrix_liveapi_search",
    {
      title: "Symbol search",
      description: "Search indexed Bitrix and project symbols: classes, interfaces, traits, functions, methods, events, components, constants, mail events, JS exports. Exact and prefix name matches rank first, then full-text relevance. Paginated.",
      inputSchema: {
        query: z.string().min(1).describe("Symbol name, Class::method, FQN, or free text."),
        type: z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant", "mail_event"]).optional().describe("Symbol type: class, interface, trait, function, method, event, component, constant, mail_event."),
        module: z.string().optional().describe("Bitrix module id, e.g. iblock, sale, main."),
        kind: searchKindSchema.optional().describe(KIND_DESCRIPTION),
        preferLocal: z.boolean().optional().describe("Boost project/template matches over core/install matches of equal relevance; default true."),
        limit: z.number().int().min(1).max(100).default(20).describe("Page size, 1-100; default 20."),
        cursor: cursorSchema,
        ...searchFormatShape
      },
      outputSchema: resultEnvelopeShape
    },
    async ({ cursor, ...query }, extra) => runWorkerTask("bitrix_liveapi_search", { name: "searchLiveApi", paths, query: { ...query, offset: decodeCursor(cursor) } }, extra)
  );

  tool(
    "bitrix_event_search",
    {
      title: "Event handler search",
      description: "Search indexed Bitrix event handlers (AddEventHandler/registerEventHandler/EventManager) by event name (\"OnAfterIBlockElementAdd\" or \"iblock:OnAfterIBlockElementAdd\"), handler class, method, or function. Paginated.",
      inputSchema: {
        query: z.string().min(1).describe("Event name, module:Event, or handler class/method/function."),
        module: z.string().optional().describe("Event module id, e.g. main, iblock, sale."),
        kind: searchKindSchema.optional().describe(KIND_DESCRIPTION),
        preferLocal: z.boolean().optional().describe("Boost project/template handlers over core/install handlers; default true."),
        limit: z.number().int().min(1).max(100).default(20).describe("Page size, 1-100; default 20."),
        cursor: cursorSchema,
        ...searchFormatShape
      },
      outputSchema: resultEnvelopeShape
    },
    async ({ cursor, ...query }, extra) => runWorkerTask("bitrix_event_search", { name: "searchEvents", paths, query: { ...query, offset: decodeCursor(cursor) } }, extra)
  );

  tool(
    "bitrix_entity_search",
    {
      title: "Bitrix entity search",
      description: "Search indexed Bitrix entities by type: agent, mail_event, component, module_usage, iblock_usage, hlblock_usage, option, orm_entity, orm_usage, autoload, relation (graph edges), inheritance (subclasses/implementors/trait users). Pick `entity`, then the filters listed for it; others are ignored and reported in warnings. Paginated.",
      inputSchema: entitySearchShape,
      outputSchema: resultEnvelopeShape
    },
    async (input, extra) => runEntity("bitrix_entity_search", input, extra)
  );

  tool(
    "bitrix_docs_search",
    {
      title: "Documentation search",
      description: "Full-text search (SQLite FTS, English and Russian stemming) in indexed Bitrix Framework documentation; no embeddings service needed. Paginated.",
      inputSchema: {
        query: z.string().min(1).describe("Words or phrase to search for."),
        limit: z.number().int().min(1).max(50).default(5).describe("Page size, 1-50; default 5."),
        cursor: cursorSchema,
        ...searchFormatShape
      },
      outputSchema: resultEnvelopeShape
    },
    async ({ cursor, ...query }, extra) => runWorkerTask("bitrix_docs_search", { name: "searchDocs", paths, query: { ...query, offset: decodeCursor(cursor) } }, extra)
  );

  tool(
    "bitrix_docs_for_symbol",
    {
      title: "Docs for symbol",
      description: "Find indexed documentation chunks that mention a Bitrix API symbol such as CIBlockElement::GetList or Loader::includeModule. Paginated.",
      inputSchema: {
        symbol: z.string().min(1).describe("API symbol, e.g. CIBlockElement::GetList (case-insensitive exact match)."),
        limit: z.number().int().min(1).max(100).default(20).describe("Page size, 1-100; default 20."),
        cursor: cursorSchema,
        format: formatSchema
      },
      outputSchema: resultEnvelopeShape
    },
    async ({ cursor, ...query }, extra) => runWorkerTask("bitrix_docs_for_symbol", { name: "docsForSymbol", paths, query: { ...query, offset: decodeCursor(cursor) } }, extra)
  );

  tool(
    "bitrix_explain_api_usage",
    {
      title: "Explain API usage",
      description: "Explain a Bitrix API in one call: documentation links (or docs search), local call sites and symbols, Bitrix core definitions, related graph edges, and deterministic recommendations.",
      inputSchema: {
        query: z.string().min(1).describe("API symbol, e.g. CIBlockElement::GetList, CEvent::Send, Loader::includeModule."),
        kind: searchKindSchema.optional().describe(`${KIND_DESCRIPTION} Applies to local usages; default project, template, install.`),
        includeDocs: z.boolean().optional().describe("Include documentation links/search results; default true."),
        includeLocalUsages: z.boolean().optional().describe("Include indexed project/template/install usages; default true."),
        includeCoreDefinition: z.boolean().optional().describe("Include indexed Bitrix core definitions; default true."),
        limit: z.number().int().min(1).max(100).default(10).describe("Maximum items per section, 1-100; default 10."),
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_explain_api_usage", { name: "explainApiUsage", paths, query }, extra)
  );

  tool(
    "bitrix_read_file_context",
    {
      title: "Read file context",
      description: "Read a bounded excerpt of a file inside the workspace or data directory, with numbered lines and path/language metadata. Secret files (.settings.php, .env, keys, dumps) are refused.",
      inputSchema: {
        file: z.string().min(1).describe("Path to read. Relative paths are resolved from workspaceRoot; absolute paths are allowed only inside workspaceRoot or dataDir."),
        line: z.number().int().min(1).describe("1-based target line number to center the context around."),
        before: z.number().int().min(0).max(500).default(5).describe("Lines to include before the target line; default 5."),
        after: z.number().int().min(0).max(500).default(20).describe("Lines to include after the target line; default 20."),
        maxChars: z.number().int().min(100).max(50_000).default(12_000).describe("Maximum characters of numbered line text; default 12000.")
      }
    },
    async ({ file, line, before, after, maxChars }, extra) => withMcpToolGuard("bitrix_read_file_context", async () => {
      const { absolutePath, relativePath } = await assertFileInsideReadAllowlist(paths, file);
      const contents = await readContextFile(absolutePath, relativePath);
      return jsonResult(buildFileContext(contents, absolutePath, relativePath, line, before, after, maxChars));
    }, extra)
  );

  tool(
    "bitrix_read_symbol_context",
    {
      title: "Read symbol context",
      description: "Read a bounded source excerpt for an indexed symbol by name, using its stored file and line. Returns candidates instead when the name is ambiguous.",
      inputSchema: {
        name: z.string().min(1).describe("Indexed symbol name: class, function, method, event, component, or constant."),
        type: symbolContextTypeSchema.optional().describe("Symbol type: class, interface, trait, function, method, event, component, constant."),
        kind: searchKindSchema.optional().describe(KIND_DESCRIPTION),
        file: z.string().optional().describe("Indexed file path or relative file path to disambiguate."),
        before: z.number().int().min(0).max(500).default(5).describe("Lines before the symbol line; default 5."),
        after: z.number().int().min(0).max(500).default(20).describe("Lines after the symbol line (after the body with includeBody); default 20."),
        includeBody: z.boolean().default(false).describe("Include the whole declaration body when lineEnd is indexed; default false."),
        maxChars: z.number().int().min(100).max(50_000).default(12_000).describe("Maximum characters of numbered line text; default 12000."),
        format: formatSchema
      }
    },
    async ({ name, type, kind, file, before, after, includeBody, maxChars, format }, extra) => withMcpToolGuard("bitrix_read_symbol_context", async () => {
      const matches = await searchSymbolsForContext(dbFile, { name, type, kind, file, limit: 25 }) ?? [];
      const resultBase = { query: { name, type, kind, file } };

      if (matches.length === 0) {
        const result: ReadSymbolContextResult = {
          ...resultBase,
          ambiguous: false,
          candidates: [],
          message: `No indexed symbol matched ${name}. Run bitrix_index (scope project) or narrow the query after indexing.`
        };
        return jsonResult(result);
      }

      if (matches.length > 1) {
        const result: ReadSymbolContextResult = {
          ...resultBase,
          ambiguous: true,
          candidates: matches.map((symbol) => symbolForFormat(symbol, format)),
          message: `Symbol ${name} is ambiguous; provide type, kind, or file to select one candidate.`
        };
        return jsonResult(result);
      }

      const symbol = matches[0];
      const { absolutePath, relativePath } = await assertFileInsideReadAllowlist(paths, symbol.file);
      const contents = await readContextFile(absolutePath, relativePath);
      const effectiveAfter = includeBody && symbol.lineEnd !== undefined && symbol.lineEnd >= symbol.line
        ? (symbol.lineEnd - symbol.line) + after
        : after;
      const context = buildFileContext(contents, absolutePath, relativePath, symbol.line, before, effectiveAfter, maxChars);
      const result: ReadSymbolContextResult = {
        ...resultBase,
        ambiguous: false,
        symbol: symbolForFormat({ ...symbol, file: absolutePath, relativeFile: relativePath }, format),
        context
      };
      return jsonResult(result);
    }, extra)
  );

  tool(
    "bitrix_component_context",
    {
      title: "Component context",
      description: "For one component (e.g. bitrix:catalog.section): its IncludeComponent calls, resolved template files and assets, extracted params, and stored relations.",
      inputSchema: {
        component: z.string().min(1).describe("Component name, e.g. bitrix:catalog.section."),
        template: z.string().optional().describe("Component template; default .default."),
        callFile: z.string().optional().describe("Restrict to calls in this file."),
        includeFiles: z.boolean().optional().describe("Include resolved template files; default true."),
        includeAssets: z.boolean().optional().describe("Include template script.js/style.css assets; default true."),
        includeParams: z.boolean().optional().describe("Include extracted call params; default true."),
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_component_context", { name: "getComponentContext", paths, query }, extra)
  );

  tool(
    "bitrix_orm_entity_map",
    {
      title: "ORM entity map",
      description: "Return indexed D7 ORM getMap() fields and references for an entity selected by class, table, or file.",
      inputSchema: {
        className: z.string().optional().describe("DataManager class, e.g. Vendor\\Module\\ProductTable."),
        tableName: z.string().optional().describe("Database table, e.g. b_vendor_product."),
        file: z.string().optional().describe("File that declares the entity."),
        format: formatSchema
      },
      outputSchema: resultEnvelopeShape
    },
    async (query, extra) => runWorkerTask("bitrix_orm_entity_map", { name: "getOrmEntityMap", paths, query }, extra)
  );

  tool(
    "bitrix_graph_neighbors",
    {
      title: "Graph neighbors",
      description: "Neighbors of a node in the Bitrix dependency graph (bitrix_relations): in/out/both directions, relation filter, bounded depth. Node ids are type:name, e.g. event main:OnBeforeProlog.",
      inputSchema: {
        nodeType: z.string().min(1).describe(NODE_TYPES_DESCRIPTION),
        nodeName: z.string().min(1).describe("Node name, e.g. main:OnBeforeProlog, Vendor\\Module\\Handler::onProlog, local/php_interface/init.php."),
        direction: graphDirectionSchema,
        relationType: z.string().optional().describe(RELATION_TYPES_DESCRIPTION),
        depth: z.number().int().min(1).max(5).optional().describe("Neighbor depth, 1-5; default 1."),
        limit: z.number().int().min(1).max(1000).default(100).describe("Maximum nodes and edges, 1-1000; default 100."),
        maxEdgesPerNode: maxEdgesPerNodeSchema,
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_graph_neighbors", { name: "graphNeighbors", paths, query }, extra)
  );

  tool(
    "bitrix_graph_traverse",
    {
      title: "Graph traverse",
      description: "Bounded, cycle-safe BFS over the Bitrix dependency graph from a start node.",
      inputSchema: {
        startType: z.string().min(1).describe(NODE_TYPES_DESCRIPTION),
        startName: z.string().min(1).describe("Start node name."),
        direction: graphDirectionSchema,
        maxDepth: z.number().int().min(0).max(8).optional().describe("Traversal depth, 0-8; default 2."),
        relationTypes: z.array(z.string().min(1)).max(25).optional().describe(`Follow only these edge types. ${RELATION_TYPES_DESCRIPTION}`),
        limit: z.number().int().min(1).max(1000).default(100).describe("Maximum nodes and edges, 1-1000; default 100."),
        maxEdgesPerNode: maxEdgesPerNodeSchema,
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_graph_traverse", { name: "graphTraverse", paths, query }, extra)
  );

  tool(
    "bitrix_impact_radius",
    {
      title: "Impact radius",
      description: "Impacted events, handlers, components, templates, ORM entities, agents, mail events, iblocks, hlblocks, modules, options, classes, and methods for changed files (given, or git-changed since base), with optional risk score.",
      inputSchema: {
        files: z.array(z.string().min(1)).max(1000).optional().describe("Workspace-relative changed files; default: git changes since base."),
        base: z.string().optional().describe("Git base ref used when files are not given; default HEAD~1."),
        maxDepth: z.number().int().min(0).max(8).optional().describe("Graph depth, 0-8; default 2."),
        relationTypes: z.array(z.string().min(1)).max(25).optional().describe(`Follow only these edge types. ${RELATION_TYPES_DESCRIPTION}`),
        includeChangedSymbols: z.boolean().optional().describe("Include the indexed symbols of the changed files."),
        includeRisk: z.boolean().optional().describe("Include a weighted risk score."),
        limit: z.number().int().min(1).max(1000).default(100).describe("Maximum nodes and edges, 1-1000; default 100."),
        maxEdgesPerNode: maxEdgesPerNodeSchema,
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_impact_radius", { name: "impactRadius", paths, query }, extra)
  );

  tool(
    "bitrix_detect_changes",
    {
      title: "Detect changes",
      description: "Analyze git-changed (including untracked and deleted) files against the index: symbol-level diff (added/removed/changed), deleted files, affected events, module usages, agents, mail events, components, ORM/IBlock/HLBlock/options, relations, graph impact, risk, and recommendations. Start code reviews here.",
      inputSchema: {
        base: z.string().optional().describe("Git base ref for git diff <base> (working tree vs base) plus untracked files; default HEAD~1."),
        kind: changedFileKindFilterSchema.optional().describe("Changed-file kinds: project, template, component, bitrix, install, docs, asset, unknown."),
        includeSource: z.boolean().optional().describe("Include compact source signatures when available."),
        includeRelations: z.boolean().optional().describe("Include related relation rows; default true."),
        includeImpact: z.boolean().optional().describe("Include graph impact radius; default true."),
        includeRisk: z.boolean().optional().describe("Include merged file/entity/graph risk; default true."),
        symbolDiff: z.boolean().optional().describe("Include the symbol-level diff of changed PHP/JS/TS files; default true."),
        diffBaseline: z.enum(["auto", "index", "git"]).optional().describe("Before state for the symbol diff: index (SQLite index), git (file at base), or auto (index when older than the working tree, else git; default)."),
        maxDepth: z.number().int().min(0).max(8).optional().describe("Graph impact depth, 0-8; default 2."),
        maxFiles: z.number().int().min(1).max(1000).optional().describe("Maximum changed files analyzed."),
        maxItems: z.number().int().min(1).max(1000).optional().describe("Maximum items per result section."),
        format: formatSchema
      }
    },
    async (query, extra) => runWorkerTask("bitrix_detect_changes", { name: "detectChanges", paths, query }, extra)
  );

  if (paths.semanticEnabled) {
    const embeddings = new EmbeddingsClient(paths.embeddingsUrl);

    tool(
      "bitrix_semantic_docs_search",
      {
        title: "Semantic docs search",
        description: "Semantic search in Bitrix documentation through the Python sentence-transformers service (BITRIX_MCP_SEMANTIC_ENABLED=1). Not paginated; truncated tells whether more matches exist.",
        inputSchema: {
          query: z.string().min(1).describe("Natural-language question or phrase."),
          limit: z.number().int().min(1).max(20).default(5).describe("Maximum results, 1-20; default 5."),
          ...searchFormatShape
        },
        outputSchema: resultEnvelopeShape
      },
      async ({ query, limit, includeSignature, maxSignatureChars, maxTextChars, format }, extra) => withMcpToolGuard("bitrix_semantic_docs_search", async () => {
        const hits = await embeddings.search(query, limit + 1);
        const results = formatSemanticDocSearchResults(hits.slice(0, limit), { query, includeSignature, maxSignatureChars, maxTextChars, format }) as Array<Record<string, unknown>>;
        const truncated = hits.length > limit;
        return structuredResult({ count: results.length, ...(truncated ? {} : { total: results.length }), truncated, results });
      }, extra)
    );
  }

  if (paths.dbEnabled) {
    tool(
      "bitrix_db_connections",
      {
        title: "DB connections",
        description: "List database connections from bitrix/.settings.php. Passwords are redacted (only hasPassword is reported). Requires BITRIX_MCP_DB_ENABLED=1.",
        inputSchema: {}
      },
      async (_args, extra) => runWorkerTask("bitrix_db_connections", { name: "dbConnections", paths, query: {} }, extra)
    );

    tool(
      "bitrix_db_schema",
      {
        title: "DB schema",
        description: "Tables and columns from information_schema for a connection. Filter by table or prefix to bound output.",
        inputSchema: {
          table: z.string().optional().describe("Exact table name to describe."),
          prefix: z.string().optional().describe("Only tables whose name starts with this prefix, e.g. b_iblock."),
          connection: z.string().optional().describe("Connection name from .settings.php; default \"default\"."),
          limit: z.number().int().min(1).max(2000).optional().describe("Maximum tables; default 200.")
        }
      },
      async (query, extra) => runWorkerTask("bitrix_db_schema", { name: "dbSchema", paths, query }, extra)
    );

    tool(
      "bitrix_db_query",
      {
        title: "DB query (read-only)",
        description: "Run a read-only SQL query (SELECT/SHOW/EXPLAIN/DESCRIBE/WITH only) against the project database with read-only credentials when configured. Row-limited.",
        inputSchema: {
          sql: z.string().min(1).describe("Read-only SQL statement. Only SELECT/SHOW/EXPLAIN/DESCRIBE/WITH are permitted."),
          connection: z.string().optional().describe("Connection name from .settings.php; default \"default\"."),
          limit: z.number().int().min(1).max(10000).optional().describe("Maximum rows; default 500.")
        }
      },
      async (query, extra) => runWorkerTask("bitrix_db_query", { name: "dbQuery", paths, query }, extra)
    );

    if (paths.dbAllowWrite) {
      tool(
        "bitrix_db_execute",
        {
          title: "DB execute (write)",
          description: "Run a write SQL statement (INSERT/UPDATE/DELETE/...) against the project database. Registered only when BITRIX_MCP_DB_ALLOW_WRITE=1. Use with care on a local dev database.",
          inputSchema: {
            sql: z.string().min(1).describe("Write SQL statement to execute."),
            connection: z.string().optional().describe("Connection name from .settings.php; default \"default\".")
          }
        },
        async ({ sql, connection }, extra) => {
          await confirmDangerousCall(server, "bitrix_db_execute", `Connection: ${connection ?? "default"}\n\n${sql}`);
          return runWorkerTask("bitrix_db_execute", { name: "dbExecute", paths, query: { sql, connection } }, extra);
        }
      );
    }
  }

  if (paths.tinkerEnabled) {
    tool(
      "bitrix_tinker",
      {
        title: "Run PHP (tinker)",
        description: "Execute arbitrary PHP with the Bitrix kernel bootstrapped (D7 API, ORM, Loader::includeModule, Option::get, ...), like Laravel Tinker. Return a value with a top-level `return <expr>;`. DANGEROUS: full code execution and write access on the local dev environment. Requires BITRIX_MCP_TINKER_ENABLED=1.",
        inputSchema: {
          code: z.string().min(1).describe("PHP code to run with Bitrix loaded. Use `return <expr>;` to get a serialized value back; echoed output is captured separately. A leading <?php tag is optional."),
          timeoutMs: z.number().int().min(1000).max(600000).optional().describe("Max execution time in milliseconds; default 30000.")
        }
      },
      async ({ code, timeoutMs }, extra) => {
        await confirmDangerousCall(server, "bitrix_tinker", code);
        return runWorkerTask("bitrix_tinker", { name: "tinker", paths, query: { code, timeoutMs } }, extra);
      }
    );
  }

  if (options.legacyTools ?? legacyToolsEnabled()) {
    registerLegacyTools(server, { runEntity, runIndex });
  }

  registerPrompts(server, dbFile);

  server.registerResource(
    "bitrix-docs-index",
    "bitrix-docs://index",
    { title: "Bitrix Framework documentation index", description: "List of available local Bitrix Framework documentation resources.", mimeType: "application/json" },
    async (uri) => {
      const resources = await listDocResources(paths.dataDir);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(resources) }] };
    }
  );

  server.registerResource(
    "bitrix-docs",
    new ResourceTemplate("bitrix-docs://{source}/{path*}", {
      list: async () => {
        const resources = await listDocResources(paths.dataDir);
        return {
          resources: resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType
          }))
        };
      }
    }),
    { title: "Bitrix Framework documentation", description: "Indexed Bitrix Framework documentation resources from registered SQLite doc sources." },
    async (uri) => {
      const { contents, resource } = await readDocResource(paths.dataDir, uri.href);
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: contents }] };
    }
  );

  return server;
}

export async function serveStdio(paths: RuntimePaths = resolveRuntimePaths()): Promise<void> {
  const server = createMcpServer(paths);
  server.server.onclose = () => { void closeWorkerPools(); };
  // The stdio transport does not notice EOF on stdin; close explicitly so workers stop with the client.
  process.stdin.once("end", () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}
