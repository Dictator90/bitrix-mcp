import { parentPort, workerData } from "node:worker_threads";
import { indexPath, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { formatIndexAllResult, indexAll } from "../indexer/actions.js";
import { buildIndex } from "../indexer/indexer.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents, type LiveApiEventQuery, type LiveApiQuery } from "../liveapi/search.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { formatDocSearchResults, formatEventSearchResults, formatLiveApiSearchResults, type SearchFormatOptions } from "./format.js";

type WorkerTask =
  | { name: "indexProject"; paths: RuntimePaths; root?: string }
  | { name: "indexTemplate"; paths: RuntimePaths; templatePath?: string; root?: string }
  | { name: "indexAll"; paths: RuntimePaths }
  | { name: "indexDocs"; paths: RuntimePaths }
  | { name: "searchLiveApi"; paths: RuntimePaths; query: LiveApiQuery & SearchFormatOptions }
  | { name: "searchEvents"; paths: RuntimePaths; query: LiveApiEventQuery & SearchFormatOptions }
  | { name: "searchDocs"; paths: RuntimePaths; query: { query: string; limit?: number } & SearchFormatOptions };

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
