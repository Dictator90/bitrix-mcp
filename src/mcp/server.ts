import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveRuntimePaths, type RuntimePaths } from "../config/paths.js";
import { readIndexStatus } from "../indexer/actions.js";
import { detectLanguage } from "../indexer/language.js";
import { listDocResources, readDocResource } from "../resources/docs.js";
import { runWorkerTask, withMcpToolGuard } from "./toolGuards.js";
import { EmbeddingsClient } from "../search/embeddingsClient.js";
import { formatSemanticDocSearchResults } from "./format.js";

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
const searchKindSchema = z.union([indexKindSchema, z.array(indexKindSchema).min(1)]);

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
    "bitrix_liveapi_search",
    "Search indexed Bitrix symbols: functions, classes, methods, events, components, constants, and frontend exports.",
    {
      query: z.string().min(1),
      type: z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant"]).optional(),
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
