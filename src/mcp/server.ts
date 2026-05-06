import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexPath, resolveRuntimePaths, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { buildIndex } from "../indexer/indexer.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchLiveApi, searchSqliteDocs } from "../liveapi/search.js";
import { listDocResources, readDocResource, indexDocResourcesToSqlite } from "../resources/docs.js";
import { EmbeddingsClient } from "../search/embeddingsClient.js";

export function createMcpServer(paths: RuntimePaths = resolveRuntimePaths()): McpServer {
  const server = new McpServer({ name: "bitrix-mcp", version: "0.1.0" });
  const embeddings = new EmbeddingsClient(paths.embeddingsUrl);

  server.tool(
    "bitrix_liveapi_search",
    "Search indexed Bitrix PHP symbols: functions, classes, methods, events, components, and constants.",
    {
      query: z.string().min(1),
      type: z.enum(["class", "interface", "trait", "function", "method", "event", "component", "constant"]).optional(),
      module: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20)
    },
    async ({ query, type, module, limit }) => {
      const results = await searchLiveApi(sqlitePath(paths.dataDir), { query, type, module, limit }) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_index_project",
    "Index the current project for Bitrix-aware navigation.",
    {
      root: z.string().optional()
    },
    async ({ root }) => {
      const manifest = await buildIndex({ root: root ?? paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project") });
      return { content: [{ type: "text", text: `Indexed ${manifest.files.length} project files.` }] };
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
      const options = resolveTemplateIndexOptions(paths, templatePath ?? root);
      const manifest = await buildIndex(options);
      return { content: [{ type: "text", text: `Indexed ${manifest.files.length} template files.` }] };
    }
  );

  server.tool(
    "bitrix_docs_search",
    "Local SQL/FTS search in indexed Bitrix Framework documentation without the Python embeddings service.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(5)
    },
    async ({ query, limit }) => {
      await indexDocResourcesToSqlite(paths.docsDir, paths.dataDir);
      const results = await searchSqliteDocs(sqlitePath(paths.dataDir), { query, limit }) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_semantic_docs_search",
    "Semantic search in Bitrix Framework documentation through the Python sentence-transformers service.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5)
    },
    async ({ query, limit }) => {
      const results = await embeddings.search(query, limit);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.resource(
    "bitrix-docs-index",
    "bitrix-docs://index",
    { title: "Bitrix Framework documentation index", description: "List of available local Bitrix Framework documentation resources.", mimeType: "application/json" },
    async (uri) => {
      const resources = await listDocResources(paths.docsDir);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(resources, null, 2) }] };
    }
  );

  server.resource(
    "bitrix-docs-getting-started",
    "bitrix-docs://framework/getting-started.md",
    { title: "Bitrix Framework getting started", description: "Bundled quick reference for Bitrix Framework indexing.", mimeType: "text/markdown" },
    async (uri) => {
      const { contents, resource } = await readDocResource(paths.docsDir, uri.href);
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: contents }] };
    }
  );

  return server;
}

export async function serveStdio(paths: RuntimePaths = resolveRuntimePaths()): Promise<void> {
  const server = createMcpServer(paths);
  await server.connect(new StdioServerTransport());
}
