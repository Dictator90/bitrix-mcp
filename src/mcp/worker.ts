import { parentPort, workerData } from "node:worker_threads";
import { indexPath, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { detectChanges, type DetectChangesOptions } from "../indexer/detectChanges.js";
import { formatIndexAllResult, indexAll } from "../indexer/actions.js";
import { buildIndex } from "../indexer/indexer.js";
import { getOrmEntityMap, searchAgents, searchBitrixRelations, searchMailEvents, searchModuleUsages, searchOrmEntities, searchOrmUsages, type AgentSearchQuery, type BitrixRelationSearchQuery, type MailEventSearchQuery, type ModuleUsageSearchQuery, type OrmEntityMapQuery, type OrmSearchQuery, type OrmUsageSearchQuery } from "../indexer/sqliteStore.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents, type LiveApiEventQuery, type LiveApiQuery } from "../liveapi/search.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { formatAgentSearchResults, formatBitrixRelationSearchResults, formatDocSearchResults, formatEventSearchResults, formatLiveApiSearchResults, formatMailEventSearchResults, formatModuleUsageSearchResults, formatOrmEntityResults, formatOrmUsageResults, type MailEventSearchFormatOptions, type ModuleUsageSearchFormatOptions, type OrmSearchFormatOptions, type RelationSearchFormatOptions, type SearchFormatOptions } from "./format.js";

type WorkerTask =
  | { name: "indexProject"; paths: RuntimePaths; root?: string }
  | { name: "indexTemplate"; paths: RuntimePaths; templatePath?: string; root?: string }
  | { name: "indexAll"; paths: RuntimePaths }
  | { name: "indexDocs"; paths: RuntimePaths }
  | { name: "searchLiveApi"; paths: RuntimePaths; query: LiveApiQuery & SearchFormatOptions }
  | { name: "searchEvents"; paths: RuntimePaths; query: LiveApiEventQuery & SearchFormatOptions }
  | { name: "searchDocs"; paths: RuntimePaths; query: { query: string; limit?: number } & SearchFormatOptions }
  | { name: "searchBitrixRelations"; paths: RuntimePaths; query: BitrixRelationSearchQuery & RelationSearchFormatOptions }
  | { name: "searchAgents"; paths: RuntimePaths; query: AgentSearchQuery & { format?: "compact" | "full" } }
  | { name: "searchMailEvents"; paths: RuntimePaths; query: MailEventSearchQuery & MailEventSearchFormatOptions }
  | { name: "searchModuleUsages"; paths: RuntimePaths; query: ModuleUsageSearchQuery & ModuleUsageSearchFormatOptions }
  | { name: "searchOrmEntities"; paths: RuntimePaths; query: OrmSearchQuery & OrmSearchFormatOptions }
  | { name: "getOrmEntityMap"; paths: RuntimePaths; query: OrmEntityMapQuery & OrmSearchFormatOptions }
  | { name: "searchOrmUsages"; paths: RuntimePaths; query: OrmUsageSearchQuery & OrmSearchFormatOptions }
  | { name: "detectChanges"; paths: RuntimePaths; query: DetectChangesOptions };

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
    case "searchAgents": {
      const results = await searchAgents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatAgentSearchResults(results, task.query), null, 2) }] };
    }
    case "searchBitrixRelations": {
      const results = await searchBitrixRelations(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatBitrixRelationSearchResults(results, task.query), null, 2) }] };
    }
    case "searchMailEvents": {
      const results = await searchMailEvents(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatMailEventSearchResults(results, task.query), null, 2) }] };
    }
    case "searchModuleUsages": {
      const results = await searchModuleUsages(sqlitePath(task.paths.dataDir), task.query) ?? [];
      return { content: [{ type: "text", text: JSON.stringify(formatModuleUsageSearchResults(results, task.query), null, 2) }] };
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
  }
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
