import { parentPort, workerData } from "node:worker_threads";
import { indexPath, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { detectChanges, type DetectChangesOptions } from "../indexer/detectChanges.js";
import { getGraphNeighbors, getImpactRadiusForPaths, traverseGraph, type GraphNeighborsOptions, type GraphTraverseOptions, type ImpactRadiusOptions } from "../indexer/graph.js";
import { formatIndexAllResult, indexAll } from "../indexer/actions.js";
import { buildIndex } from "../indexer/indexer.js";
import { getComponentContext, getOrmEntityMap, getProjectOverview, searchAgents, searchAutoloadRecords, searchBitrixRelations, searchDocSymbolRefs, searchComponents, searchHlblockUsages, searchIblockUsages, searchMailEvents, searchModuleUsages, searchOptionUsages, searchOrmEntities, searchOrmUsages, type AgentSearchQuery, type AutoloadSearchQuery, type BitrixRelationSearchQuery, type ProjectOverviewOptions, type ComponentContextQuery, type ComponentSearchQuery, type HlblockUsageSearchQuery, type IblockUsageSearchQuery, type MailEventSearchQuery, type ModuleUsageSearchQuery, type OptionSearchQuery, type OrmEntityMapQuery, type OrmSearchQuery, type OrmUsageSearchQuery } from "../indexer/sqliteStore.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents, type LiveApiEventQuery, type LiveApiQuery } from "../liveapi/search.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { formatAgentSearchResults, formatAutoloadSearchResults, formatBitrixRelationSearchResults, formatComponentContextResult, formatComponentSearchResults, formatDocSearchResults, formatEventSearchResults, formatHlblockUsageSearchResults, formatIblockUsageSearchResults, formatLiveApiSearchResults, formatMailEventSearchResults, formatModuleUsageSearchResults, formatOptionSearchResults, formatOrmEntityResults, formatOrmUsageResults, type AutoloadSearchFormatOptions, type HlblockUsageSearchFormatOptions, type IblockUsageSearchFormatOptions, type MailEventSearchFormatOptions, type ModuleUsageSearchFormatOptions, type OptionSearchFormatOptions, type OrmSearchFormatOptions, type RelationSearchFormatOptions, type SearchFormatOptions } from "./format.js";
import { readBitrixConnections, redactConnection, resolveConnection } from "../liveapi/settingsPhpParser.js";
import { runQuery, getSchema } from "../db/mysqlClient.js";
import { runTinker } from "../php/tinker.js";

type WorkerTask =
  | { name: "indexProject"; paths: RuntimePaths; root?: string }
  | { name: "indexTemplate"; paths: RuntimePaths; templatePath?: string; root?: string }
  | { name: "indexAll"; paths: RuntimePaths }
  | { name: "indexDocs"; paths: RuntimePaths }
  | { name: "searchLiveApi"; paths: RuntimePaths; query: LiveApiQuery & SearchFormatOptions }
  | { name: "searchEvents"; paths: RuntimePaths; query: LiveApiEventQuery & SearchFormatOptions }
  | { name: "searchDocs"; paths: RuntimePaths; query: { query: string; limit?: number } & SearchFormatOptions }
  | { name: "docsForSymbol"; paths: RuntimePaths; query: { symbol: string; limit?: number; format?: "compact" | "full" } }
  | { name: "explainApiUsage"; paths: RuntimePaths; query: { query: string; kind?: LiveApiQuery["kind"]; includeDocs?: boolean; includeLocalUsages?: boolean; includeCoreDefinition?: boolean; limit?: number; format?: "compact" | "full" } }
  | { name: "searchBitrixRelations"; paths: RuntimePaths; query: BitrixRelationSearchQuery & RelationSearchFormatOptions }
  | { name: "searchAutoloadRecords"; paths: RuntimePaths; query: AutoloadSearchQuery & AutoloadSearchFormatOptions }
  | { name: "projectOverview"; paths: RuntimePaths; query: Partial<ProjectOverviewOptions> }
  | { name: "searchComponents"; paths: RuntimePaths; query: ComponentSearchQuery & { format?: "compact" | "full" } }
  | { name: "getComponentContext"; paths: RuntimePaths; query: ComponentContextQuery }
  | { name: "searchAgents"; paths: RuntimePaths; query: AgentSearchQuery & { format?: "compact" | "full" } }
  | { name: "searchMailEvents"; paths: RuntimePaths; query: MailEventSearchQuery & MailEventSearchFormatOptions }
  | { name: "searchModuleUsages"; paths: RuntimePaths; query: ModuleUsageSearchQuery & ModuleUsageSearchFormatOptions }
  | { name: "searchIblockUsages"; paths: RuntimePaths; query: IblockUsageSearchQuery & IblockUsageSearchFormatOptions }
  | { name: "searchHlblockUsages"; paths: RuntimePaths; query: HlblockUsageSearchQuery & HlblockUsageSearchFormatOptions }
  | { name: "searchOptionUsages"; paths: RuntimePaths; query: OptionSearchQuery & OptionSearchFormatOptions }
  | { name: "searchOrmEntities"; paths: RuntimePaths; query: OrmSearchQuery & OrmSearchFormatOptions }
  | { name: "getOrmEntityMap"; paths: RuntimePaths; query: OrmEntityMapQuery & OrmSearchFormatOptions }
  | { name: "searchOrmUsages"; paths: RuntimePaths; query: OrmUsageSearchQuery & OrmSearchFormatOptions }
  | { name: "detectChanges"; paths: RuntimePaths; query: DetectChangesOptions }
  | { name: "graphNeighbors"; paths: RuntimePaths; query: { nodeType: string; nodeName: string } & GraphNeighborsOptions }
  | { name: "graphTraverse"; paths: RuntimePaths; query: { startType: string; startName: string } & GraphTraverseOptions }
  | { name: "impactRadius"; paths: RuntimePaths; query: ImpactRadiusOptions }
  | { name: "dbConnections"; paths: RuntimePaths; query: Record<string, never> }
  | { name: "dbSchema"; paths: RuntimePaths; query: { connection?: string; table?: string; prefix?: string; limit?: number } }
  | { name: "dbQuery"; paths: RuntimePaths; query: { sql: string; connection?: string; limit?: number } }
  | { name: "dbExecute"; paths: RuntimePaths; query: { sql: string; connection?: string } }
  | { name: "tinker"; paths: RuntimePaths; query: { code: string; timeoutMs?: number } };

export async function runTask(task: WorkerTask): Promise<unknown> {
  switch (task.name) {
    case "indexProject": {
      const manifest = await buildIndex({ root: task.root ?? task.paths.workspaceRoot, kind: "project", outFile: indexPath(task.paths.dataDir, "project") });
      return { content: [{ type: "text", text: `Indexed ${manifest.files.length} project files.` }] };
    }
    case "indexTemplate": {
      const options = resolveTemplateIndexOptions(task.paths, task.templatePath ?? task.root);
      const manifest = await buildIndex(options);
      return { content: [{ type: "text", text: `Indexed ${manifest.files.length} template files.` }] };
    }
    case "indexAll": {
      const result = await indexAll(task.paths);
      return { content: [{ type: "text", text: formatIndexAllResult(result) }] };
    }
    case "indexDocs": {
      const chunks = await indexDocResourcesToSqlite(task.paths.dataDir, task.paths.docsPaths, { includeOfficialDocs: task.paths.officialDocsEnabled ?? false });
      return { content: [{ type: "text", text: `Indexed ${chunks} documentation chunks.` }] };
    }
    case "searchLiveApi": {
      const results = await searchLiveApi(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatLiveApiSearchResults(results, task.query), null, 2) }] };
    }
    case "searchEvents": {
      const results = await searchSqliteEvents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatEventSearchResults(results, task.query), null, 2) }] };
    }
    case "searchDocs": {
      const results = await searchSqliteDocs(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatDocSearchResults(results, task.query), null, 2) }] };
    }
    case "docsForSymbol": {
      const refs = await searchDocSymbolRefs(sqlitePath(task.paths.dataDir), task.query.symbol, task.query.limit ?? 20) ?? [];
      const results = task.query.format === "full" ? refs : refs.map((ref) => ({
        title: ref.title,
        uri: ref.docUri,
        path: ref.docPath,
        chunkIndex: ref.chunkIndex,
        excerpt: ref.excerpt
      }));
      return { content: [{ type: "text", text: JSON.stringify({ symbol: task.query.symbol, results }, null, 2) }] };
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
      const localUsages = includeLocalUsages
        ? formatLiveApiSearchResults(await searchLiveApi(dbFile, { query: task.query.query, kind: localKinds, preferLocal: true, limit }) ?? [], { query: task.query.query, format }) ?? []
        : [];
      const coreDefinitions = includeCoreDefinition
        ? formatLiveApiSearchResults(await searchLiveApi(dbFile, { query: task.query.query, kind: "bitrix", preferLocal: false, limit }) ?? [], { query: task.query.query, format }) ?? []
        : [];
      const sourceRelations = await searchBitrixRelations(dbFile, { sourceName: task.query.query, limit }) ?? [];
      const targetRelations = await searchBitrixRelations(dbFile, { targetName: task.query.query, limit }) ?? [];
      const relationMap = new Map([...sourceRelations, ...targetRelations].map((relation) => [`${relation.sourceType}:${relation.sourceName}:${relation.relationType}:${relation.targetType}:${relation.targetName}:${relation.file}:${relation.line}`, relation]));
      const relations = [...relationMap.values()].slice(0, limit);
      const recommendations = apiUsageRecommendations(task.query.query);
      return { content: [{ type: "text", text: JSON.stringify({ query: task.query.query, docs, localUsages, coreDefinitions, relations, recommendations }, null, 2) }] };
    }
    case "searchAgents": {
      const results = await searchAgents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatAgentSearchResults(results, task.query), null, 2) }] };
    }
    case "searchBitrixRelations": {
      const results = await searchBitrixRelations(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatBitrixRelationSearchResults(results, task.query), null, 2) }] };
    }
    case "searchAutoloadRecords": {
      const results = await searchAutoloadRecords(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatAutoloadSearchResults(results, task.query), null, 2) }] };
    }
    case "projectOverview": {
      const result = await getProjectOverview(sqlitePath(task.paths.dataDir), { workspaceRoot: task.paths.workspaceRoot, bitrixRoot: task.paths.bitrixRoot, sqlitePath: sqlitePath(task.paths.dataDir), ...task.query });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "searchComponents": {
      const results = await searchComponents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatComponentSearchResults(results, task.query), null, 2) }] };
    }
    case "getComponentContext": {
      const result = await getComponentContext(sqlitePath(task.paths.dataDir), task.query) ?? { component: task.query.component, template: task.query.template ?? ".default", calls: [], templateFiles: [], assets: [], parameters: [], relations: [] };
      return { content: [{ type: "text", text: JSON.stringify(formatComponentContextResult(result, task.query), null, 2) }] };
    }
    case "searchMailEvents": {
      const results = await searchMailEvents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatMailEventSearchResults(results, task.query), null, 2) }] };
    }
    case "searchModuleUsages": {
      const results = await searchModuleUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatModuleUsageSearchResults(results, task.query), null, 2) }] };
    }
    case "searchIblockUsages": {
      const results = await searchIblockUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatIblockUsageSearchResults(results, task.query), null, 2) }] };
    }
    case "searchHlblockUsages": {
      const results = await searchHlblockUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatHlblockUsageSearchResults(results, task.query), null, 2) }] };
    }
    case "searchOptionUsages": {
      const results = await searchOptionUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatOptionSearchResults(results, task.query), null, 2) }] };
    }
    case "searchOrmEntities": {
      const results = await searchOrmEntities(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatOrmEntityResults(results, task.query), null, 2) }] };
    }
    case "getOrmEntityMap": {
      const results = await getOrmEntityMap(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatOrmEntityResults(results, task.query), null, 2) }] };
    }
    case "searchOrmUsages": {
      const results = await searchOrmUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatOrmUsageResults(results, task.query), null, 2) }] };
    }
    case "detectChanges": {
      const result = await detectChanges(task.paths, task.query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "graphNeighbors": {
      const result = await getGraphNeighbors(sqlitePath(task.paths.dataDir), { type: task.query.nodeType, name: task.query.nodeName }, task.query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "graphTraverse": {
      const result = await traverseGraph(sqlitePath(task.paths.dataDir), { type: task.query.startType, name: task.query.startName }, task.query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "impactRadius": {
      const result = await getImpactRadiusForPaths(task.paths, task.query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "dbConnections": {
      const { connections, source, error } = await readBitrixConnections(task.paths);
      const result = { connections: connections.map((connection) => redactConnection(connection, source)), source, ...(error ? { error } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "dbSchema": {
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No matching DB connection found in bitrix/.settings.php." }, null, 2) }] };
      }
      const schema = await getSchema(conn, { table: task.query.table, prefix: task.query.prefix, limit: task.query.limit });
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    }
    case "dbQuery": {
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No matching DB connection found in bitrix/.settings.php." }, null, 2) }] };
      }
      const result = await runQuery(conn, task.query.sql, { readOnly: true, rowLimit: task.query.limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "dbExecute": {
      if (!task.paths.dbAllowWrite) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Write access disabled. Set BITRIX_MCP_DB_ALLOW_WRITE=1 to enable bitrix_db_execute." }, null, 2) }] };
      }
      const conn = await resolveConnection(task.paths, task.query.connection);
      if (!conn) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No matching DB connection found in bitrix/.settings.php." }, null, 2) }] };
      }
      const result = await runQuery(conn, task.query.sql, { readOnly: false });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "tinker": {
      const result = await runTinker(task.paths, task.query.code, { timeoutMs: task.query.timeoutMs });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

const activeParentPort = parentPort;
if (activeParentPort) {
  runTask(workerData as WorkerTask)
    .then((result) => activeParentPort.postMessage({ ok: true, result }))
    .catch((error: unknown) => {
      activeParentPort.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    });
}
