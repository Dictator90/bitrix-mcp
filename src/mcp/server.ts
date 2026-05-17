import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveRuntimePaths, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { readIndexStatus } from "../indexer/actions.js";
import { searchInheritanceRelations, searchSymbolsForContext } from "../indexer/sqliteStore.js";
import { detectLanguage } from "../indexer/language.js";
import { listDocResources, readDocResource } from "../resources/docs.js";
import { runWorkerTask, withMcpToolGuard } from "./toolGuards.js";
import { EmbeddingsClient } from "../search/embeddingsClient.js";
import { formatSemanticDocSearchResults } from "./format.js";
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

function normalizeProjectRoot(paths: RuntimePaths, root?: string): string {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  const resolvedRoot = path.resolve(root ?? workspaceRoot);
  if (!allowOutsideWorkspace() && !isInsideWorkspace(workspaceRoot, resolvedRoot)) {
    throw pathRestrictionError("bitrix_index_project", "root", root, resolvedRoot, workspaceRoot);
  }
  return resolvedRoot;
}

function containsParentSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/u).includes("..");
}

function normalizeTemplateRoot(paths: RuntimePaths, templatePath?: string): string {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  if (!templatePath) return workspaceRoot;

  const resolvedRoot = path.resolve(workspaceRoot, templatePath);
  if (!allowOutsideWorkspace()) {
    if (path.isAbsolute(templatePath)) {
      throw new Error(`MCP path restriction: bitrix_index_template parameter "templatePath" must be relative to workspaceRoot (${workspaceRoot}); absolute paths are disabled by default. Received ${templatePath}. Set ${ALLOW_OUTSIDE_WORKSPACE_ENV}=1 to explicitly allow indexing outside the workspace.`);
    }
    if (containsParentSegment(templatePath)) {
      throw new Error(`MCP path restriction: bitrix_index_template parameter "templatePath" must not contain ".." path segments by default. Received ${templatePath}; resolved to ${resolvedRoot}. Set ${ALLOW_OUTSIDE_WORKSPACE_ENV}=1 to explicitly allow indexing outside the workspace.`);
    }
    if (!isInsideWorkspace(workspaceRoot, resolvedRoot)) {
      throw pathRestrictionError("bitrix_index_template", "templatePath", templatePath, resolvedRoot, workspaceRoot);
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
  const relativePath = isInsideWorkspace(workspaceRoot, realFilePath)
    ? path.relative(workspaceRoot, realFilePath)
    : path.relative(matchingRoot, realFilePath);

  return { absolutePath: realFilePath, relativePath };
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

const indexKindSchema = z.enum(["project", "bitrix", "template", "install"]);
const searchKindSchema = z.union([indexKindSchema, z.array(indexKindSchema).min(1).max(4)]);
const symbolContextTypeSchema = z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant"]);
const inheritanceRelationSchema = z.enum(["extends", "implements", "uses_trait", "any"]);
const changedFileKindSchema = z.enum(["project", "template", "component", "bitrix", "install", "docs", "asset", "unknown"]);
const changedFileKindFilterSchema = z.union([changedFileKindSchema, z.array(changedFileKindSchema).min(1).max(8)]);

function compactInheritanceRelation(relation: { sourceName: string; targetName: string; relationType: string; targetType: string; file: string; line: number; module?: string; kind?: string; signature?: string }): Record<string, unknown> {
  return {
    className: relation.sourceName,
    relation: relation.relationType,
    targetType: relation.targetType,
    targetName: relation.targetName,
    module: relation.module,
    kind: relation.kind,
    file: relation.file,
    line: relation.line,
    signature: relation.signature
  };
}

const searchFormatSchema = {
  includeSignature: z.boolean().optional().describe("Include the compact signature field; enabled by default."),
  maxSignatureChars: z.number().int().min(20).max(2_000).optional().describe("Maximum characters for compact signatures; default is 160."),
  maxTextChars: z.number().int().min(80).max(10_000).optional().describe("Maximum characters for documentation excerpts in compact mode; default is 500."),
  format: z.enum(["compact", "full"]).optional().describe("compact returns short fields by default; full returns the raw indexed result payload.")
};

export function createMcpServer(paths: RuntimePaths = resolveRuntimePaths()): McpServer {
  const server = new McpServer({ name: "bitrix-mcp", version: "0.1.0" });

  server.tool(
    "bitrix_read_file_context",
    "Read a bounded source-code excerpt from a file inside the configured workspace or Bitrix MCP data directory, returning numbered lines and path/language metadata.",
    {
      file: z.string().min(1).describe("Path to read. Relative paths are resolved from workspaceRoot; absolute paths are allowed only inside workspaceRoot or dataDir."),
      line: z.number().int().min(1).describe("1-based target line number to center the context around."),
      before: z.number().int().min(0).max(500).default(5).describe("Number of lines to include before the target line; default is 5."),
      after: z.number().int().min(0).max(500).default(20).describe("Number of lines to include after the target line; default is 20."),
      maxChars: z.number().int().min(100).max(50_000).default(12_000).describe("Maximum characters of numbered line text to return; default is 12000.")
    },
    async ({ file, line, before, after, maxChars }) => {
      return withMcpToolGuard("bitrix_read_file_context", async () => {
        const { absolutePath, relativePath } = await assertFileInsideReadAllowlist(paths, file);
        const contents = await fs.readFile(absolutePath, "utf8");
        const context = buildFileContext(contents, absolutePath, relativePath, line, before, after, maxChars);
        return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
      });
    }
  );

  server.tool(
    "bitrix_read_symbol_context",
    "Read a bounded source-code excerpt by indexed Bitrix symbol name, using the stored file and line metadata instead of requiring callers to provide file + line.",
    {
      name: z.string().min(1).describe("Indexed symbol name to read, for example a class, function, method, event, component, or constant name."),
      type: symbolContextTypeSchema.optional(),
      kind: searchKindSchema.optional().describe("Restrict symbol lookup to one kind or an array of kinds: project, template, bitrix, or install."),
      file: z.string().optional().describe("Optional indexed file path or relative file path to disambiguate symbols."),
      before: z.number().int().min(0).max(500).default(5),
      after: z.number().int().min(0).max(500).default(20),
      includeBody: z.boolean().default(false).describe("When true and the symbol has lineEnd metadata, include the full declaration body plus before/after padding."),
      maxChars: z.number().int().min(100).max(50_000).default(12_000),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ name, type, kind, file, before, after, includeBody, maxChars, format }) => {
      return withMcpToolGuard("bitrix_read_symbol_context", async () => {
        const matches = await searchSymbolsForContext(sqlitePath(paths.dataDir), { name, type, kind, file, limit: 25 }) ?? [];
        const resultBase = { query: { name, type, kind, file } };

        if (matches.length === 0) {
          const result: ReadSymbolContextResult = {
            ...resultBase,
            ambiguous: false,
            candidates: [],
            message: `No indexed symbol matched ${name}. Run bitrix_index_project or narrow the query after indexing.`
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        if (matches.length > 1) {
          const result: ReadSymbolContextResult = {
            ...resultBase,
            ambiguous: true,
            candidates: matches.map((symbol) => symbolForFormat(symbol, format)),
            message: `Symbol ${name} is ambiguous; provide type, kind, or file to select one candidate.`
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        const symbol = matches[0];
        const { absolutePath, relativePath } = await assertFileInsideReadAllowlist(paths, symbol.file);
        const contents = await fs.readFile(absolutePath, "utf8");
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
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    "bitrix_inheritance_search",
    "Find indexed PHP classes that extend a parent class, implement an interface, or use a trait using stored Bitrix relation rows.",
    {
      target: z.string().min(1).describe("Parent class, interface, or trait name. Fully qualified and short names are both supported where possible."),
      relation: inheritanceRelationSchema.default("any"),
      kind: searchKindSchema.optional().describe("Restrict relation lookup to one kind or an array of kinds: project, template, bitrix, or install."),
      module: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ target, relation, kind, module, limit, format }) => {
      return withMcpToolGuard("bitrix_inheritance_search", async () => {
        const relations = await searchInheritanceRelations(sqlitePath(paths.dataDir), { target, relation, kind, module, limit }) ?? [];
        const result = {
          query: { target, relation, kind, module },
          count: relations.length,
          results: format === "full" ? relations : relations.map(compactInheritanceRelation)
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    "bitrix_liveapi_search",
    "Search indexed Bitrix symbols: functions, classes, methods, events, components, constants, and frontend exports.",
    {
      query: z.string().min(1),
      type: z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant", "mail_event"]).optional(),
      module: z.string().optional(),
      kind: searchKindSchema.optional().describe("Restrict results to one kind or an array of kinds: project, bitrix, template, or install."),
      preferLocal: z.boolean().optional().describe("When true (default), boost project and template matches ahead of Bitrix core/install matches with equal relevance."),
      limit: z.number().int().min(1).max(100).default(20),
      ...searchFormatSchema
    },
    async ({ query, type, module, kind, preferLocal, limit, includeSignature, maxSignatureChars, maxTextChars, format }) => {
      return runWorkerTask("bitrix_liveapi_search", { name: "searchLiveApi", paths, query: { query, type, module, kind, preferLocal, limit, includeSignature, maxSignatureChars, maxTextChars, format } });
    }
  );

  server.tool(
    "bitrix_event_search",
    "Search indexed Bitrix event handlers by event module, event name, handler class, handler method, or handler function.",
    {
      query: z.string().min(1),
      module: z.string().optional(),
      kind: searchKindSchema.optional().describe("Restrict results to one kind or an array of kinds: project, bitrix, template, or install."),
      preferLocal: z.boolean().optional().describe("When true (default), boost project and template handlers ahead of Bitrix core/install handlers with equal relevance."),
      limit: z.number().int().min(1).max(100).default(20),
      ...searchFormatSchema
    },
    async ({ query, module, kind, preferLocal, limit, includeSignature, maxSignatureChars, maxTextChars, format }) => {
      return runWorkerTask("bitrix_event_search", { name: "searchEvents", paths, query: { query, module, kind, preferLocal, limit, includeSignature, maxSignatureChars, maxTextChars, format } });
    }
  );



  server.tool(
    "bitrix_agent_search",
    "Search indexed Bitrix CAgent registrations by callable name, module, kind, or file. Compact output is returned by default.",
    {
      query: z.string().optional(),
      module: z.string().optional(),
      kind: searchKindSchema.optional().describe("Restrict results to one kind or an array of kinds: project, bitrix, template, or install."),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns agent name/module/schedule/location; full returns raw agent symbol records.")
    },
    async ({ query, module, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_agent_search", { name: "searchAgents", paths, query: { query, module, kind, file, limit, format } });
    }
  );


  server.tool(
    "bitrix_mail_event_search",
    "Search indexed Bitrix mail event sending calls and optionally include mail-related OnBeforeEventSend/OnBeforeEventAdd handlers.",
    {
      query: z.string().optional(),
      eventName: z.string().optional(),
      api: z.string().optional(),
      kind: searchKindSchema.optional().describe("Restrict results to one kind or an array of kinds: project, bitrix, template, or install."),
      file: z.string().optional(),
      includeHandlers: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns eventName/api/kind/file/line/signature; full returns raw mail event symbol records.")
    },
    async ({ query, eventName, api, kind, file, includeHandlers, limit, format }) => {
      return runWorkerTask("bitrix_mail_event_search", { name: "searchMailEvents", paths, query: { query, eventName, api, kind, file, includeHandlers, limit, format } });
    }
  );


  server.tool(
    "bitrix_component_search",
    "Search indexed Bitrix IncludeComponent calls by component name, template, kind, file, params, or free text.",
    {
      query: z.string().optional(),
      component: z.string().optional(),
      template: z.string().optional(),
      kind: searchKindSchema.optional(),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ query, component, template, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_component_search", { name: "searchComponents", paths, query: { query, component, template, kind, file, limit, format } });
    }
  );

  server.tool(
    "bitrix_component_context",
    "Return calls, resolved template files/assets, extracted params, and stored relations for a Bitrix component usage.",
    {
      component: z.string().min(1),
      template: z.string().optional(),
      callFile: z.string().optional(),
      includeFiles: z.boolean().optional(),
      includeAssets: z.boolean().optional(),
      includeParams: z.boolean().optional(),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ component, template, callFile, includeFiles, includeAssets, includeParams, format }) => {
      return runWorkerTask("bitrix_component_context", { name: "getComponentContext", paths, query: { component, template, callFile, includeFiles, includeAssets, includeParams, format } });
    }
  );

  server.tool(
    "bitrix_module_usage_search",
    "Search indexed Bitrix module include/check API usages by module, call, kind, or file.",
    {
      module: z.string().optional(),
      call: z.string().optional(),
      kind: searchKindSchema.optional().describe("Restrict results to one kind or an array of kinds: project, bitrix, template, or install."),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns module/call/kind/file/line/signature fields; full returns raw module usage records.")
    },
    async ({ module, call, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_module_usage_search", { name: "searchModuleUsages", paths, query: { module, call, kind, file, limit, format } });
    }
  );

  server.tool(
    "bitrix_iblock_usage_search",
    "Search indexed Bitrix IBlock API usages by IBLOCK_ID, API call, kind, file, or free text.",
    {
      query: z.string().optional(),
      iblockId: z.string().optional(),
      api: z.string().optional(),
      kind: searchKindSchema.optional(),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns iblockId/api/kind/file/line/context/signature; full returns raw IBlock usage records.")
    },
    async ({ query, iblockId, api, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_iblock_usage_search", { name: "searchIblockUsages", paths, query: { query, iblockId, api, kind, file, limit, format } });
    }
  );

  server.tool(
    "bitrix_hlblock_usage_search",
    "Search indexed Bitrix Highloadblock API usages by HLBLOCK_ID/code, API call, kind, file, or free text.",
    {
      query: z.string().optional(),
      hlblockId: z.string().optional(),
      api: z.string().optional(),
      kind: searchKindSchema.optional(),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns hlblockId/api/kind/file/line/context/signature; full returns raw Highloadblock usage records.")
    },
    async ({ query, hlblockId, api, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_hlblock_usage_search", { name: "searchHlblockUsages", paths, query: { query, hlblockId, api, kind, file, limit, format } });
    }
  );


  server.tool(
    "bitrix_option_search",
    "Search indexed Bitrix module option reads/writes by module, option name, operation, API call, kind, file, or free text.",
    {
      query: z.string().optional(),
      module: z.string().optional(),
      name: z.string().optional(),
      operation: z.enum(["get", "set"]).optional(),
      api: z.string().optional(),
      kind: searchKindSchema.optional(),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns option module/name/operation/api/kind/file/line/context/signature; full returns raw option records.")
    },
    async ({ query, module, name, operation, api, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_option_search", { name: "searchOptionUsages", paths, query: { query, module, name, operation, api, kind, file, limit, format } });
    }
  );

  server.tool(
    "bitrix_orm_search",
    "Search indexed Bitrix D7 ORM DataManager entities by class, table, module, kind, or free text.",
    {
      query: z.string().optional(),
      tableName: z.string().optional(),
      className: z.string().optional(),
      module: z.string().optional(),
      kind: searchKindSchema.optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ query, tableName, className, module, kind, limit, format }) => {
      return runWorkerTask("bitrix_orm_search", { name: "searchOrmEntities", paths, query: { query, tableName, className, module, kind, limit, format } });
    }
  );

  server.tool(
    "bitrix_orm_entity_map",
    "Return indexed Bitrix D7 ORM getMap fields and references for an entity selected by class, table, or file.",
    {
      className: z.string().optional(),
      tableName: z.string().optional(),
      file: z.string().optional(),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ className, tableName, file, format }) => {
      return runWorkerTask("bitrix_orm_entity_map", { name: "getOrmEntityMap", paths, query: { className, tableName, file, format } });
    }
  );

  server.tool(
    "bitrix_orm_usage_search",
    "Search indexed Bitrix D7 ORM usage calls such as ProductTable::getList(), query(), add(), update(), delete(), and compileEntity helpers.",
    {
      query: z.string().optional(),
      entity: z.string().optional(),
      method: z.string().optional(),
      file: z.string().optional(),
      kind: searchKindSchema.optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ query, entity, method, file, kind, limit, format }) => {
      return runWorkerTask("bitrix_orm_usage_search", { name: "searchOrmUsages", paths, query: { query, entity, method, file, kind, limit, format } });
    }
  );

  server.tool(
    "bitrix_autoload_search",
    "Search indexed Composer autoload mappings, dependencies, classmaps, autoload files, and Bitrix bootstrap/config files.",
    {
      query: z.string().optional(),
      namespace: z.string().optional(),
      package: z.string().optional(),
      type: z.enum(["psr-4", "files", "classmap", "dependency", "dev_dependency", "bootstrap"]).optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ query, namespace, package: packageName, type, limit, format }) => {
      return runWorkerTask("bitrix_autoload_search", { name: "searchAutoloadRecords", paths, query: { query, namespace, package: packageName, type, limit, format } });
    }
  );

  server.tool(
    "bitrix_relation_search",
    "Search stored generic Bitrix relations by source, target, relation type, module, kind, or file. Compact output is returned by default.",
    {
      sourceType: z.string().optional(),
      sourceName: z.string().optional(),
      targetType: z.string().optional(),
      targetName: z.string().optional(),
      relationType: z.string().optional(),
      module: z.string().optional(),
      kind: z.string().optional(),
      file: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      format: z.enum(["compact", "full"]).optional().describe("compact returns short source/target fields by default; full returns raw relation records.")
    },
    async ({ sourceType, sourceName, targetType, targetName, relationType, module, kind, file, limit, format }) => {
      return runWorkerTask("bitrix_relation_search", { name: "searchBitrixRelations", paths, query: { sourceType, sourceName, targetType, targetName, relationType, module, kind, file, limit, format } });
    }
  );


  server.tool(
    "bitrix_graph_neighbors",
    "Return Bitrix-aware graph neighbors for a node from indexed bitrix_relations. Supports in/out/both directions, relation filters, bounded depth, and compact output by default.",
    {
      nodeType: z.string().min(1),
      nodeName: z.string().min(1),
      direction: z.enum(["out", "in", "both"]).optional(),
      relationType: z.string().optional(),
      depth: z.number().int().min(1).max(5).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ nodeType, nodeName, direction, relationType, depth, limit, format }) => {
      return runWorkerTask("bitrix_graph_neighbors", { name: "graphNeighbors", paths, query: { nodeType, nodeName, direction, relationType, depth, limit, format } });
    }
  );

  server.tool(
    "bitrix_graph_traverse",
    "BFS traverse the Bitrix-aware dependency graph from indexed bitrix_relations. Results are cycle-safe, bounded, and compact by default.",
    {
      startType: z.string().min(1),
      startName: z.string().min(1),
      direction: z.enum(["out", "in", "both"]).optional(),
      maxDepth: z.number().int().min(0).max(8).optional(),
      relationTypes: z.array(z.string().min(1)).max(25).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ startType, startName, direction, maxDepth, relationTypes, limit, format }) => {
      return runWorkerTask("bitrix_graph_traverse", { name: "graphTraverse", paths, query: { startType, startName, direction, maxDepth, relationTypes, limit, format } });
    }
  );

  server.tool(
    "bitrix_impact_radius",
    "Find impacted Bitrix events, handlers, components, templates, ORM entities, agents, mail events, iblocks, hlblocks, modules, options, classes, and methods for changed files.",
    {
      files: z.array(z.string().min(1)).max(1000).optional(),
      base: z.string().optional().describe("Git base ref used when files are not provided; defaults to HEAD~1."),
      maxDepth: z.number().int().min(0).max(8).optional(),
      relationTypes: z.array(z.string().min(1)).max(25).optional(),
      includeChangedSymbols: z.boolean().optional(),
      includeRisk: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ files, base, maxDepth, relationTypes, includeChangedSymbols, includeRisk, limit, format }) => {
      return runWorkerTask("bitrix_impact_radius", { name: "impactRadius", paths, query: { files, base, maxDepth, relationTypes, includeChangedSymbols, includeRisk, limit, format } });
    }
  );


  server.tool(
    "bitrix_detect_changes",
    "Analyze Git-changed Bitrix files against the SQLite index and graph impact, returning changed symbols, events, module usages, agents, mail events, components, ORM/IBlock/HLBlock/options, relations, risk, and recommendations.",
    {
      base: z.string().optional().describe("Git base ref for git diff --name-only <base> --; defaults to HEAD~1."),
      kind: changedFileKindFilterSchema.optional().describe("Restrict changed files by detected kind: project, template, component, bitrix, install, docs, asset, or unknown."),
      includeSource: z.boolean().optional().describe("Include compact source signatures when available."),
      includeRelations: z.boolean().optional().describe("Include related relation rows; enabled by default."),
      includeImpact: z.boolean().optional().describe("Include graph impact radius; enabled by default."),
      includeRisk: z.boolean().optional().describe("Include merged file/entity/graph risk; enabled by default."),
      maxDepth: z.number().int().min(0).max(8).optional().describe("Graph impact traversal depth; defaults to 2."),
      maxFiles: z.number().int().min(1).max(1000).optional(),
      maxItems: z.number().int().min(1).max(1000).optional(),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ base, kind, includeSource, includeRelations, includeImpact, includeRisk, maxDepth, maxFiles, maxItems, format }) => {
      return runWorkerTask("bitrix_detect_changes", { name: "detectChanges", paths, query: { base, kind, includeSource, includeRelations, includeImpact, includeRisk, maxDepth, maxFiles, maxItems, format } });
    }
  );

  server.tool(
    "bitrix_project_overview",
    "Return a compact Bitrix project overview: index status, counters, top Bitrix entities, autoload coverage, and warnings. Call this before large tasks after bitrix_index_status.",
    {
      includeTopFiles: z.boolean().optional(),
      includeModules: z.boolean().optional(),
      includeComponents: z.boolean().optional(),
      includeEvents: z.boolean().optional(),
      includeOrm: z.boolean().optional(),
      includeAgents: z.boolean().optional(),
      includeMailEvents: z.boolean().optional(),
      includeWarnings: z.boolean().optional(),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ includeTopFiles, includeModules, includeComponents, includeEvents, includeOrm, includeAgents, includeMailEvents, includeWarnings, format }) => {
      return runWorkerTask("bitrix_project_overview", { name: "projectOverview", paths, query: { includeTopFiles, includeModules, includeComponents, includeEvents, includeOrm, includeAgents, includeMailEvents, includeWarnings, format } });
    }
  );

  server.tool(
    "bitrix_index_project",
    "Index the current project for Bitrix-aware navigation.",
    {
      root: z.string().optional()
    },
    async ({ root }) => {
      const resolvedRoot = normalizeProjectRoot(paths, root);
      return runWorkerTask("bitrix_index_project", { name: "indexProject", paths, root: resolvedRoot });
    }
  );

  server.tool(
    "bitrix_index_template",
    "Index Bitrix templates, components, scripts, and styles separately from the full project. Set templatePath relative to the project root, for example local/templates/site.",
    {
      templatePath: z.string().optional().describe("Template directory path relative to the project root, for example local/templates/site."),
      root: z.string().optional().describe("Deprecated: use templatePath instead. Temporary compatibility alias for a template path relative to the project root.")
    },
    async ({ templatePath, root }) => {
      const resolvedRoot = normalizeTemplateRoot(paths, templatePath ?? root);
      return runWorkerTask("bitrix_index_template", { name: "indexTemplate", paths, templatePath: resolvedRoot });
    }
  );

  server.tool(
    "bitrix_index_all",
    "Index the project, templates, Bitrix modules, module install assets, and registered documentation sources into SQLite.",
    {},
    async () => {
      return runWorkerTask("bitrix_index_all", { name: "indexAll", paths });
    }
  );

  server.tool(
    "bitrix_index_status",
    "Show the Bitrix MCP SQLite DB path and current index counters for files, symbols, events, documents, and last index time.",
    {},
    async () => {
      return withMcpToolGuard("bitrix_index_status", async () => {
        const status = await readIndexStatus(paths);
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      });
    }
  );

  server.tool(
    "bitrix_docs_search",
    "Local SQL/FTS search in indexed Bitrix Framework documentation without the Python embeddings service.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(5),
      ...searchFormatSchema
    },
    async ({ query, limit, includeSignature, maxSignatureChars, maxTextChars, format }) => {
      return runWorkerTask("bitrix_docs_search", { name: "searchDocs", paths, query: { query, limit, includeSignature, maxSignatureChars, maxTextChars, format } });
    }
  );


  server.tool(
    "bitrix_docs_for_symbol",
    "Find indexed documentation chunks that mention a Bitrix API symbol such as CIBlockElement::GetList or Loader::includeModule.",
    {
      symbol: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ symbol, limit, format }) => {
      return runWorkerTask("bitrix_docs_for_symbol", { name: "docsForSymbol", paths, query: { symbol, limit, format } });
    }
  );

  server.tool(
    "bitrix_explain_api_usage",
    "Explain Bitrix API usage by combining documentation symbol links or docs search, local usages, Bitrix core definitions, relations, and deterministic recommendations.",
    {
      query: z.string().min(1),
      kind: searchKindSchema.optional().describe("Restrict local usage lookup to one kind or an array of kinds: project, template, bitrix, or install. Defaults to project/template/install."),
      includeDocs: z.boolean().optional().describe("Include documentation links/search results; enabled by default."),
      includeLocalUsages: z.boolean().optional().describe("Include indexed project/template/install usages; enabled by default."),
      includeCoreDefinition: z.boolean().optional().describe("Include indexed Bitrix core definitions; enabled by default."),
      limit: z.number().int().min(1).max(100).default(10),
      format: z.enum(["compact", "full"]).optional()
    },
    async ({ query, kind, includeDocs, includeLocalUsages, includeCoreDefinition, limit, format }) => {
      return runWorkerTask("bitrix_explain_api_usage", { name: "explainApiUsage", paths, query: { query, kind, includeDocs, includeLocalUsages, includeCoreDefinition, limit, format } });
    }
  );

  server.tool(
    "bitrix_index_docs",
    "Clone/pull and index Bitrix documentation sources into the local SQLite documentation index, including the official Bitrix Framework docs repository when enabled.",
    {},
    async () => {
      return runWorkerTask("bitrix_index_docs", { name: "indexDocs", paths });
    }
  );

  if (paths.semanticEnabled) {
    const embeddings = new EmbeddingsClient(paths.embeddingsUrl);

    server.tool(
      "bitrix_semantic_docs_search",
      "Optional semantic search in Bitrix Framework documentation through the Python sentence-transformers service. Enable with BITRIX_MCP_SEMANTIC_ENABLED=1.",
      {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        ...searchFormatSchema
      },
      async ({ query, limit, includeSignature, maxSignatureChars, maxTextChars, format }) => {
        return withMcpToolGuard("bitrix_semantic_docs_search", async () => {
          const results = await embeddings.search(query, limit);
          return { content: [{ type: "text", text: JSON.stringify(formatSemanticDocSearchResults(results, { query, includeSignature, maxSignatureChars, maxTextChars, format }), null, 2) }] };
        });
      }
    );
  }

  server.resource(
    "bitrix-docs-index",
    "bitrix-docs://index",
    { title: "Bitrix Framework documentation index", description: "List of available local Bitrix Framework documentation resources.", mimeType: "application/json" },
    async (uri) => {
      const resources = await listDocResources(paths.dataDir);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(resources, null, 2) }] };
    }
  );

  server.resource(
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
  await server.connect(new StdioServerTransport());
}
