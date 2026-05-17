import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { indexPath, resolveBitrixProjectRoot, resolveRuntimePaths, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { detectChanges } from "../indexer/detectChanges.js";
import { getGraphNeighbors, getImpactRadiusForPaths, traverseGraph } from "../indexer/graph.js";
import { buildIndex } from "../indexer/indexer.js";
import { formatIndexAllResult, indexAll, readIndexStatus } from "../indexer/actions.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";
import { searchBitrixRelations } from "../indexer/sqliteStore.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../liveapi/search.js";

export interface BenchmarkOptions {
  force?: boolean;
  outputDir?: string;
}

export interface BenchmarkStep {
  name: string;
  status: "ok" | "skipped" | "warning";
  elapsedMs?: number;
  warning?: string;
  details?: Record<string, unknown>;
}

export interface BenchmarkReport {
  generatedAt: string;
  workspaceRoot: string;
  bitrixRoot?: string;
  dbFile: string;
  force: boolean;
  steps: BenchmarkStep[];
  metrics: {
    dbSizeBytes: number;
    indexedFiles: number;
    symbols: number;
    events: number;
    relations: number;
    docsChunks: number;
  };
  warnings: string[];
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function fileSize(targetPath: string): Promise<number> {
  try {
    return (await fs.stat(targetPath)).size;
  } catch {
    return 0;
  }
}

async function timeStep(name: string, action: () => Promise<Record<string, unknown> | void>): Promise<BenchmarkStep> {
  const started = performance.now();
  try {
    const details = await action();
    return { name, status: "ok", elapsedMs: performance.now() - started, details: details ?? undefined };
  } catch (error) {
    return { name, status: "warning", elapsedMs: performance.now() - started, warning: error instanceof Error ? error.message : String(error) };
  }
}

function skipped(name: string, warning: string): BenchmarkStep {
  return { name, status: "skipped", warning };
}

function stepValue(step: BenchmarkStep): string {
  if (step.status === "skipped") return `skipped — ${step.warning}`;
  const elapsed = step.elapsedMs === undefined ? "n/a" : `${step.elapsedMs.toFixed(1)} ms`;
  return step.status === "warning" ? `${elapsed} — warning: ${step.warning}` : elapsed;
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const rows = report.steps.map((step) => `| ${step.name} | ${step.status} | ${stepValue(step).replace(/\|/gu, "\\|")} |`);
  const warnings = report.warnings.length > 0
    ? report.warnings.map((warning) => `- ${warning}`).join("\n")
    : "- None";

  return `# Bitrix MCP Benchmark Report

Generated at: ${report.generatedAt}

Workspace: \`${report.workspaceRoot}\`  
Bitrix root: ${report.bitrixRoot ? `\`${report.bitrixRoot}\`` : "not detected"}  
SQLite DB: \`${report.dbFile}\`  
Force reindex: ${report.force ? "yes" : "no"}

## Timings

| Step | Status | Result |
| --- | --- | --- |
${rows.join("\n")}

## Counters

| Metric | Value |
| --- | ---: |
| SQLite DB size | ${report.metrics.dbSizeBytes} bytes |
| Indexed files | ${report.metrics.indexedFiles} |
| Symbols | ${report.metrics.symbols} |
| Events | ${report.metrics.events} |
| Relations | ${report.metrics.relations} |
| Docs chunks | ${report.metrics.docsChunks} |

## Warnings

${warnings}
`;
}

async function hasDocs(paths: RuntimePaths): Promise<boolean> {
  const checks = await Promise.all(paths.docsPaths.map((docsPath) => directoryExists(docsPath)));
  return checks.some(Boolean);
}

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const resolvedPaths = resolveRuntimePaths({ officialDocsEnabled: false });
  const paths: RuntimePaths = { ...resolvedPaths, officialDocsEnabled: false };
  const outputDir = path.resolve(options.outputDir ?? paths.dataDir);
  const dbFile = sqlitePath(paths.dataDir);
  const force = options.force === true;
  const steps: BenchmarkStep[] = [];

  await fs.mkdir(outputDir, { recursive: true });

  steps.push(await timeStep("index-all", async () => {
    const result = await indexAll(paths, { force });
    return { summary: formatIndexAllResult(result) };
  }));

  steps.push(await timeStep("index-project", async () => {
    const manifest = await buildIndex({ root: paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project"), force });
    return { files: manifest.files.length };
  }));

  steps.push(await timeStep("index-template", async () => {
    const manifest = await buildIndex({ ...resolveTemplateIndexOptions(paths), force });
    return { files: manifest.files.length };
  }));

  const bitrixDir = paths.bitrixRoot ? path.join(paths.bitrixRoot, "bitrix") : undefined;
  if (!paths.bitrixRoot || !bitrixDir || !(await directoryExists(bitrixDir))) {
    steps.push(skipped("index-bitrix", "Bitrix root was not detected; set BITRIX_ROOT or run from a project containing ./bitrix."));
  } else {
    steps.push(await timeStep("index-bitrix", async () => {
      const projectRoot = resolveBitrixProjectRoot(paths.bitrixRoot as string);
      const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: ["bitrix/modules/**/*.php", "local/modules/**/*.php"], force });
      return { files: manifest.files.length };
    }));
  }

  const status = await readIndexStatus(paths);

  if (status.docChunks === 0 && !(await hasDocs(paths))) {
    steps.push(skipped("docs search latency", "No documentation index or documentation directory was found."));
  } else if (status.docChunks === 0) {
    steps.push(skipped("docs search latency", "No indexed documentation chunks were found."));
  } else {
    steps.push(await timeStep("docs search latency", async () => {
      const results = await searchSqliteDocs(dbFile, { query: "Bitrix", limit: 5 });
      return { results: results?.length ?? 0 };
    }));
  }

  if (status.symbols === 0) {
    steps.push(skipped("liveapi search latency", "No indexed symbols were found."));
  } else {
    steps.push(await timeStep("liveapi search latency", async () => {
      const results = await searchLiveApi(dbFile, { query: "Bitrix", limit: 5 });
      return { results: results?.length ?? 0 };
    }));
  }

  if (status.events === 0) {
    steps.push(skipped("event search latency", "No indexed events were found."));
  } else {
    steps.push(await timeStep("event search latency", async () => {
      const results = await searchSqliteEvents(dbFile, { query: "On", limit: 5 });
      return { results: results?.length ?? 0 };
    }));
  }

  const relations = status.relations === 0 ? [] : await searchBitrixRelations(dbFile, { limit: 1 }) ?? [];
  const firstRelation = relations[0];

  if (status.relations === 0 || !firstRelation) {
    steps.push(skipped("relation search latency", "No indexed bitrix_relations rows were found."));
    steps.push(skipped("graph traversal latency", "No indexed bitrix_relations rows were found."));
  } else {
    steps.push(await timeStep("relation search latency", async () => {
      const results = await searchBitrixRelations(dbFile, { sourceType: firstRelation.sourceType, sourceName: firstRelation.sourceName, limit: 10 });
      return { results: results?.length ?? 0 };
    }));
    steps.push(await timeStep("graph traversal latency", async () => {
      const result = await traverseGraph(dbFile, { type: firstRelation.sourceType, name: firstRelation.sourceName }, { direction: "both", maxDepth: 2, limit: 25 });
      const neighbors = await getGraphNeighbors(dbFile, { type: firstRelation.sourceType, name: firstRelation.sourceName }, { direction: "both", depth: 1, limit: 25 });
      return { nodes: result.nodes.length, edges: result.edges.length, neighbors: neighbors.neighbors.length };
    }));
  }

  if (status.files === 0) {
    steps.push(skipped("impact-radius latency", "No indexed files were found."));
  } else {
    const fileForImpact = firstRelation?.file;
    if (!fileForImpact) {
      steps.push(skipped("impact-radius latency", "No relation-backed file was available for impact analysis."));
    } else {
      steps.push(await timeStep("impact-radius latency", async () => {
        const result = await getImpactRadiusForPaths(paths, { files: [fileForImpact], maxDepth: 2, limit: 25 });
        return { changedFiles: result.changedFiles.length, startNodes: result.startNodes.length };
      }));
    }
  }

  steps.push(await timeStep("detect-changes latency", async () => {
    const result = await detectChanges(paths, { maxFiles: 25, maxItems: 25 });
    return { files: result.summary.files, symbols: result.summary.symbols, relations: result.summary.relations };
  }));

  const finalStatus = await readIndexStatus(paths);
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    workspaceRoot: paths.workspaceRoot,
    bitrixRoot: paths.bitrixRoot,
    dbFile,
    force,
    steps,
    metrics: {
      dbSizeBytes: await fileSize(dbFile),
      indexedFiles: finalStatus.files,
      symbols: finalStatus.symbols,
      events: finalStatus.events,
      relations: finalStatus.relations,
      docsChunks: finalStatus.docChunks
    },
    warnings: steps.filter((step) => step.status !== "ok").map((step) => `${step.name}: ${step.warning ?? step.status}`)
  };

  if (!(await exists(dbFile))) {
    report.warnings.push(`SQLite DB was not created at ${dbFile}.`);
  }

  await fs.writeFile(path.join(outputDir, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "benchmark.md"), formatBenchmarkMarkdown(report), "utf8");

  return report;
}
