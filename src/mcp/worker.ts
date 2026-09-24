import { indexPath, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { detectChanges, type DetectChangesOptions } from "../indexer/detectChanges.js";
import { getGraphNeighbors, getImpactRadiusForPaths, traverseGraph, type GraphNeighborsOptions, type GraphTraverseOptions, type ImpactRadiusOptions } from "../indexer/graph.js";
import { formatIndexAllResult, indexAll, installIndexOptions } from "../indexer/actions.js";
import { resolveBitrixIndex, validateBitrixModules } from "../indexer/bitrixModules.js";
import { buildIndex, relativeBaseFor } from "../indexer/indexer.js";
import { getComponentContext, searchCallSites, getOrmEntityMap, getProjectOverview, searchBitrixRelations, searchDocSymbolRefs, type ProjectOverviewOptions, type ComponentContextQuery, type OrmEntityMapQuery } from "../indexer/sqliteStore.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents, type LiveApiEventQuery, type LiveApiQuery } from "../liveapi/search.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { formatComponentContextResult, formatDocSearchResults, formatEventSearchResults, formatLiveApiSearchResults, formatOrmEntityResults, type OrmSearchFormatOptions, type SearchFormatOptions } from "./format.js";
import { jsonResult, pageRequest, paginate, RANKED_MIN_FETCH, structuredResult, WHOLE_LIST } from "./envelope.js";
import { runEntitySearch, type EntitySearchArgs } from "./entitySearch.js";
import { heavyToolTimeoutMs } from "./toolGuards.js";
import type { ProgressReporter } from "../progress/types.js";

/** Cursor-decoded page position carried by paginated search tasks. */
interface PageQuery {
  offset?: number;
}

export type WorkerTask =
  | { name: "indexProject"; paths: RuntimePaths; root?: string }
  | { name: "indexTemplate"; paths: RuntimePaths; templatePath?: string; root?: string }
  | { name: "indexBitrix"; paths: RuntimePaths; modules?: string[] }
  | { name: "indexInstall"; paths: RuntimePaths }
  | { name: "indexAll"; paths: RuntimePaths; includeInstall?: boolean }
  | { name: "indexDocs"; paths: RuntimePaths }
  | { name: "searchLiveApi"; paths: RuntimePaths; query: LiveApiQuery & SearchFormatOptions & PageQuery }
  | { name: "searchEvents"; paths: RuntimePaths; query: LiveApiEventQuery & SearchFormatOptions & PageQuery }
  | { name: "searchDocs"; paths: RuntimePaths; query: { query: string; limit?: number } & SearchFormatOptions & PageQuery }
  | { name: "docsForSymbol"; paths: RuntimePaths; query: { symbol: string; limit?: number; format?: "compact" | "full" } & PageQuery }
  | { name: "explainApiUsage"; paths: RuntimePaths; query: { query: string; kind?: LiveApiQuery["kind"]; includeDocs?: boolean; includeLocalUsages?: boolean; includeCoreDefinition?: boolean; limit?: number; format?: "compact" | "full" } }
  | { name: "entitySearch"; paths: RuntimePaths; query: EntitySearchArgs }
  | { name: "projectOverview"; paths: RuntimePaths; query: Partial<ProjectOverviewOptions> }
  | { name: "getComponentContext"; paths: RuntimePaths; query: ComponentContextQuery }
  | { name: "getOrmEntityMap"; paths: RuntimePaths; query: OrmEntityMapQuery & OrmSearchFormatOptions }
  | { name: "detectChanges"; paths: RuntimePaths; query: DetectChangesOptions }
  | { name: "graphNeighbors"; paths: RuntimePaths; query: { nodeType: string; nodeName: string } & GraphNeighborsOptions }
  | { name: "graphTraverse"; paths: RuntimePaths; query: { startType: string; startName: string } & GraphTraverseOptions }
  | { name: "impactRadius"; paths: RuntimePaths; query: ImpactRadiusOptions }
  | { name: "dbConnections"; paths: RuntimePaths; query: Record<string, never> }
  | { name: "dbSchema"; paths: RuntimePaths; query: { connection?: string; table?: string; prefix?: string; limit?: number } }
  | { name: "dbQuery"; paths: RuntimePaths; query: { sql: string; connection?: string; limit?: number } }
  | { name: "dbExecute"; paths: RuntimePaths; query: { sql: string; connection?: string } }
  | { name: "tinker"; paths: RuntimePaths; query: { code: string; timeoutMs?: number } };

export type WorkerTaskName = WorkerTask["name"];

export interface WorkerTaskContext {
  reporter?: ProgressReporter;
}

/** searchDocSymbolRefs returns at most 100 rows per read. */
const DOC_SYMBOL_REFS_WINDOW = 100;

const NO_DB_CONNECTION = { error: "No matching DB connection found in bitrix/.settings.php." };

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

// DB and tinker modules (mysql2, the .settings.php parser, the PHP runner) load on first use,
// so the read-pool workers don't pay for them.
const loadSettings = () => import("../liveapi/settingsPhpParser.js");
const loadMysql = () => import("../db/mysqlClient.js");
const loadTinker = () => import("../php/tinker.js");

export async function runTask(task: WorkerTask, context: WorkerTaskContext = {}): Promise<unknown> {
  const { reporter } = context;
  switch (task.name) {
    case "indexProject": {
      const root = task.root ?? task.paths.workspaceRoot;
      const manifest = await buildIndex({ root, relativeTo: relativeBaseFor(task.paths.workspaceRoot, root), kind: "project", outFile: indexPath(task.paths.dataDir, "project"), retainSymbols: false, reporter });
      return textResult(`Indexed ${manifest.files.length} project files.`);
    }
    case "indexTemplate": {
      const options = resolveTemplateIndexOptions(task.paths, task.templatePath ?? task.root);
      const manifest = await buildIndex({ ...options, retainSymbols: false, reporter });
      return textResult(`Indexed ${manifest.files.length} template files.`);
    }
    case "indexBitrix": {
      const projectRoot = task.paths.bitrixRoot;
      if (!projectRoot) {
        throw new Error("Bitrix root not found. Run the server from a project containing ./bitrix or set BITRIX_ROOT.");
      }
      const modules = task.modules && task.modules.length > 0 ? task.modules : "all";
      const warnings: string[] = [];
      if (modules !== "all") {
        const { found, missing } = await validateBitrixModules(projectRoot, modules);
        if (found.length === 0) throw new Error(`None of the requested Bitrix modules were found under ${projectRoot}: ${modules.join(", ")}`);
        warnings.push(...missing.map((name) => `Bitrix module "${name}" was requested but not found.`));
      }
      const resolved = resolveBitrixIndex({ modules });
      const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(task.paths.dataDir, "bitrix"), patterns: resolved.patterns, ignores: resolved.ignores, retainSymbols: false, reporter });
      return textResult([`Indexed ${manifest.files.length} Bitrix files.`, ...warnings].join("\n"));
    }
    case "indexInstall": {
      const manifest = await buildIndex({ ...installIndexOptions(task.paths), retainSymbols: false, reporter });
      return textResult(`Indexed ${manifest.files.length} install asset files.`);
    }
    case "indexAll": {
      const result = await indexAll(task.paths, { includeInstall: task.includeInstall, reporter });
      return textResult(formatIndexAllResult(result));
    }
    case "indexDocs": {
      reporter?.start({ scope: "docs", phase: "docs", status: "start", message: "Index documentation" });
      const chunks = await indexDocResourcesToSqlite(task.paths.dataDir, task.paths.docsPaths, { includeOfficialDocs: task.paths.officialDocsEnabled ?? false });
      reporter?.done({ scope: "docs", phase: "done", status: "done", docsChunks: chunks });
      return textResult(`Indexed ${chunks} documentation chunks.`);
    }
    case "searchLiveApi": {
      const { offset, ...query } = task.query;
      const page = pageRequest(query.limit ?? 20, offset, { minFetch: RANKED_MIN_FETCH });
      const results = await searchLiveApi(sqlitePath(task.paths.dataDir), { ...query, limit: page.fetch });
      return structuredResult(paginate(results, page, (rows) => formatLiveApiSearchResults(rows, query)));
    }
    case "searchEvents": {
      const { offset, ...query } = task.query;
      const page = pageRequest(query.limit ?? 20, offset, { minFetch: RANKED_MIN_FETCH });
      const results = await searchSqliteEvents(sqlitePath(task.paths.dataDir), { ...query, limit: page.fetch });
      return structuredResult(paginate(results, page, (rows) => formatEventSearchResults(rows, query)));
    }
    case "searchDocs": {
      const { offset, ...query } = task.query;
      const page = pageRequest(query.limit ?? 5, offset, { minFetch: RANKED_MIN_FETCH });
      const results = await searchSqliteDocs(sqlitePath(task.paths.dataDir), { query: query.query, limit: page.fetch });
      return structuredResult(paginate(results, page, (rows) => formatDocSearchResults(rows, query)));
    }
    case "docsForSymbol": {
      const page = pageRequest(task.query.limit ?? 20, task.query.offset, { window: DOC_SYMBOL_REFS_WINDOW });
      const refs = await searchDocSymbolRefs(sqlitePath(task.paths.dataDir), task.query.symbol, page.fetch);
      return structuredResult(paginate(refs, page, (rows) => task.query.format === "full" ? rows : rows.map((ref) => ({
        title: ref.title,
        uri: ref.docUri,
        path: ref.docPath,
        chunkIndex: ref.chunkIndex,
        excerpt: ref.excerpt
      }))));
    }
    case "explainApiUsage": {
      const dbFile = sqlitePath(task.paths.dataDir);
      const limit = task.query.limit ?? 10;
      const format = task.query.format ?? "compact";
      const includeDocs = task.query.includeDocs ?? true;
      const includeLocalUsages = task.query.includeLocalUsages ?? true;
      const includeCoreDefinition = task.query.includeCoreDefinition ?? true;
      let docs: unknown[] = [];
      if (includeDocs) {
        const refs = await searchDocSymbolRefs(dbFile, task.query.query, limit) ?? [];
        docs = refs.length > 0
          ? (format === "full" ? refs : refs.map((ref) => ({ title: ref.title, uri: ref.docUri, path: ref.docPath, chunkIndex: ref.chunkIndex, excerpt: ref.excerpt })))
          : formatDocSearchResults(await searchSqliteDocs(dbFile, { query: task.query.query, limit }) ?? [], { query: task.query.query, format }) ?? [];
      }
      const localKinds = task.query.kind ?? ["project", "template", "install"];
      let localUsages: unknown[] = [];
      if (includeLocalUsages) {
        // Call sites of the API first (where local code uses it), then matching local symbols.
        const callSites = await searchCallSites(dbFile, { query: task.query.query, kind: localKinds, limit });
        const symbols = await searchLiveApi(dbFile, { query: task.query.query, kind: localKinds, preferLocal: true, limit }) ?? [];
        localUsages = formatLiveApiSearchResults([...callSites, ...symbols].slice(0, limit), { query: task.query.query, format }) ?? [];
      }
      const coreDefinitions = includeCoreDefinition
        ? formatLiveApiSearchResults(await searchLiveApi(dbFile, { query: task.query.query, kind: "bitrix", preferLocal: false, limit }) ?? [], { query: task.query.query, format }) ?? []
        : [];
      const sourceRelations = await searchBitrixRelations(dbFile, { sourceName: task.query.query, limit }) ?? [];
      const targetRelations = await searchBitrixRelations(dbFile, { targetName: task.query.query, limit }) ?? [];
      const relationMap = new Map([...sourceRelations, ...targetRelations].map((relation) => [`${relation.sourceType}:${relation.sourceName}:${relation.relationType}:${relation.targetType}:${relation.targetName}:${relation.file}:${relation.line}`, relation]));
      const relations = [...relationMap.values()].slice(0, limit);
      const recommendations = apiUsageRecommendations(task.query.query);
      return jsonResult({ query: task.query.query, docs, localUsages, coreDefinitions, relations, recommendations });
    }
    case "entitySearch": {
      return structuredResult(await runEntitySearch(sqlitePath(task.paths.dataDir), task.query));
    }
    case "projectOverview": {
      const result = await getProjectOverview(sqlitePath(task.paths.dataDir), { workspaceRoot: task.paths.workspaceRoot, bitrixRoot: task.paths.bitrixRoot, sqlitePath: sqlitePath(task.paths.dataDir), ...task.query });
      return jsonResult(result);
    }
    case "getComponentContext": {
      const result = await getComponentContext(sqlitePath(task.paths.dataDir), task.query) ?? { component: task.query.component, template: task.query.template ?? ".default", calls: [], templateFiles: [], assets: [], parameters: [], relations: [] };
      return jsonResult(formatComponentContextResult(result, task.query));
    }
    case "getOrmEntityMap": {
      const results = await getOrmEntityMap(sqlitePath(task.paths.dataDir), task.query);
      return structuredResult(paginate(results, WHOLE_LIST, (rows) => formatOrmEntityResults(rows, task.query)));
    }
    case "detectChanges": {
      return jsonResult(await detectChanges(task.paths, task.query));
    }
    case "graphNeighbors": {
      return jsonResult(await getGraphNeighbors(sqlitePath(task.paths.dataDir), { type: task.query.nodeType, name: task.query.nodeName }, task.query));
    }
    case "graphTraverse": {
      return jsonResult(await traverseGraph(sqlitePath(task.paths.dataDir), { type: task.query.startType, name: task.query.startName }, task.query));
    }
    case "impactRadius": {
      return jsonResult(await getImpactRadiusForPaths(task.paths, task.query));
    }
    case "dbConnections": {
      const { readBitrixConnections, redactConnection } = await loadSettings();
      const { connections, source, error } = await readBitrixConnections(task.paths);
      return jsonResult({ connections: connections.map((connection) => redactConnection(connection, source)), source, ...(error ? { error } : {}) });
    }
    case "dbSchema": {
      const [{ resolveConnection, withReadOnlyCredentials }, { runQuery, getSchema }] = await Promise.all([loadSettings(), loadMysql()]);
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) return jsonResult(NO_DB_CONNECTION, true);
      return jsonResult(await getSchema(withReadOnlyCredentials(conn), { table: task.query.table, prefix: task.query.prefix, limit: task.query.limit }));
    }
    case "dbQuery": {
      const [{ resolveConnection, withReadOnlyCredentials }, { runQuery, getSchema }] = await Promise.all([loadSettings(), loadMysql()]);
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) return jsonResult(NO_DB_CONNECTION, true);
      return jsonResult(await runQuery(withReadOnlyCredentials(conn), task.query.sql, { readOnly: true, rowLimit: task.query.limit }));
    }
    case "dbExecute": {
      if (!task.paths.dbAllowWrite) {
        return jsonResult({ error: "Write access disabled. Set BITRIX_MCP_DB_ALLOW_WRITE=1 to enable bitrix_db_execute." }, true);
      }
      const [{ resolveConnection, withReadOnlyCredentials }, { runQuery, getSchema }] = await Promise.all([loadSettings(), loadMysql()]);
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) return jsonResult(NO_DB_CONNECTION, true);
      return jsonResult(await runQuery(conn, task.query.sql, { readOnly: false }));
    }
    case "tinker": {
      // Keep the PHP timeout below the worker's own timeout so PHP is killed (and temp files removed) before the worker is terminated.
      const maxTimeoutMs = Math.max(1000, heavyToolTimeoutMs() - 5000);
      const { runTinker } = await loadTinker();
      const result = await runTinker(task.paths, task.query.code, { timeoutMs: Math.min(task.query.timeoutMs ?? 30_000, maxTimeoutMs) });
      return jsonResult(result, !result.ok);
    }
  }
}

function apiUsageRecommendations(query: string): string[] {
  const normalized = query.toLowerCase();
  if (normalized.includes("ciblockelement::getlist")) {
    return ["Check filter keys, selected fields, permissions, and pagination."];
  }
  if (normalized.includes("cevent::send")) {
    return ["Check event name, site ID, fields, and mail templates."];
  }
  if (normalized.includes("loader::includemodule")) {
    return ["Check module availability before using module APIs."];
  }
  if (normalized.includes("eventmanager") || normalized.includes("addeventhandler")) {
    return ["Check handler signature and module/event names."];
  }
  return ["Check documented parameters, return values, error handling, and indexed local call sites before changing API usage."];
}
