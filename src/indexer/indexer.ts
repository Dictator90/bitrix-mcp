import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { sqlitePath } from "../config/paths.js";
import { parseJsSymbols } from "../liveapi/jsParser.js";
import { parsePhpSymbolsWithDiagnostics } from "../liveapi/phpParser.js";
import { detectLanguage } from "./language.js";
import { readExistingFilesByKind, readIndexFromSqlite, writeIndexToSqlite } from "./sqliteStore.js";
import { indexAutoloadMetadata } from "./autoload.js";
import { NoopProgressReporter } from "../progress/noopReporter.js";
import type { IndexProgressEvent, IndexScope, ProgressReporter } from "../progress/types.js";
import type { IndexFile, IndexKind, IndexManifest, IndexWarning, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";

const CODE_EXTENSIONS = "{php,js,jsx,ts,tsx,css,scss,sass,less,html,htm,xml,json,md,txt}";
export const DEFAULT_INDEX_PATTERNS = [`**/*.${CODE_EXTENSIONS}`];
const DEFAULT_IGNORES = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.bitrix-mcp/**", "**/upload/**", "**/cache/**", "**/generated/**"];
const PROJECT_KIND_IGNORES = [
  "bitrix/modules/**",
  "local/modules/**",
  "bitrix/templates/**",
  "local/templates/**",
  "bitrix/components/**",
  "local/components/**"
];
const BITRIX_KIND_IGNORES = ["bitrix/modules/*/install/**", "local/modules/*/install/**"];
export const DEFAULT_TEMPLATE_PATTERNS = [
  `bitrix/templates/**/*.${CODE_EXTENSIONS}`,
  `local/templates/**/*.${CODE_EXTENSIONS}`,
  `bitrix/components/**/*.${CODE_EXTENSIONS}`,
  `local/components/**/*.${CODE_EXTENSIONS}`
];
export const DEFAULT_BITRIX_PATTERNS = ["bitrix/modules/**/*.php", "local/modules/**/*.php"];
export const DEFAULT_INSTALL_ASSET_PATTERNS = [
  `bitrix/modules/*/install/**/*.${CODE_EXTENSIONS}`,
  `local/modules/*/install/**/*.${CODE_EXTENSIONS}`
];

export interface IndexOptions {
  root: string;
  kind: IndexKind;
  outFile?: string;
  dbFile?: string;
  patterns?: string[];
  ignores?: string[];
  force?: boolean;
  reporter?: ProgressReporter;
  /** Progress scope label; defaults to the index kind. */
  scope?: IndexScope;
}

/** Extract the Bitrix module name from a path like `bitrix/modules/iblock/lib/...`. */
function detectModule(relativePath: string): string | undefined {
  const match = relativePath.replace(/\\/g, "/").match(/(?:^|\/)(?:bitrix|local)\/modules\/([^/]+)\//);
  return match?.[1];
}

async function loadIgnore(root: string, options: { useGitignore?: boolean; extraIgnores?: string[] } = {}) {
  const ig = ignore().add([...DEFAULT_IGNORES, ...(options.extraIgnores ?? [])].map((entry) => entry.replace(/^\*\*\//, "")));
  const ignoreFiles = [
    options.useGitignore === false ? undefined : ".gitignore",
    ".bitrixmcpignore"
  ].filter((entry): entry is string => Boolean(entry));
  for (const ignoreFile of ignoreFiles) {
    try {
      const ignoreRules = await fs.readFile(path.join(root, ignoreFile), "utf8");
      ig.add(ignoreRules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Optional file.
    }
  }
  return ig;
}

function defaultPatternsForKind(kind: IndexKind): string[] {
  if (kind === "template") return DEFAULT_TEMPLATE_PATTERNS;
  if (kind === "bitrix") return DEFAULT_BITRIX_PATTERNS;
  if (kind === "install") return DEFAULT_INSTALL_ASSET_PATTERNS;
  return DEFAULT_INDEX_PATTERNS;
}

function defaultIgnoresForKind(kind: IndexKind): string[] {
  if (kind === "project") return PROJECT_KIND_IGNORES;
  if (kind === "bitrix") return BITRIX_KIND_IGNORES;
  return [];
}

export async function buildIndex(options: IndexOptions): Promise<IndexManifest> {
  const startedAt = Date.now();
  const reporter = options.reporter ?? new NoopProgressReporter();
  const scope: IndexScope = options.scope ?? options.kind;
  const root = path.resolve(options.root);
  const patterns = options.patterns ?? defaultPatternsForKind(options.kind);
  const kindIgnores = [...defaultIgnoresForKind(options.kind), ...(options.ignores ?? [])];
  const dbFile = options.dbFile ?? sqlitePath(path.dirname(options.outFile ?? path.join(root, ".bitrix-mcp", "legacy-index.json")));
  const existingFiles = options.force ? [] : await readExistingFilesByKind(dbFile, options.kind);
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));

  reporter.start({ scope, phase: "discover", status: "start", startedAt });
  const ig = await loadIgnore(root, {
    useGitignore: options.kind !== "bitrix" && options.kind !== "install",
    extraIgnores: kindIgnores
  });
  const entries = await fg(patterns, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...DEFAULT_IGNORES, ...kindIgnores]
  });
  const queued = entries.filter((relativePath) => !ig.ignores(relativePath)).sort();
  reporter.done({
    scope,
    phase: "discover",
    status: "done",
    foundFiles: entries.length,
    ignoredFiles: entries.length - queued.length,
    queuedFiles: queued.length
  });

  const files: IndexFile[] = [];
  const warnings: IndexWarning[] = [];
  const debugParse = process.env.BITRIX_MCP_DEBUG_PARSE === "1";
  let symbolCount = 0;
  let relationCount = 0;
  let skippedFiles = 0;
  const total = queued.length;
  reporter.start({ scope, phase: "parse", status: "start", message: "Parse files", total, startedAt: Date.now() });
  let processed = 0;
  for (const relativePath of queued) {
    processed += 1;
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.stat(absolutePath);
    const language = detectLanguage(absolutePath);
    const existing = existingByPath.get(absolutePath);
    const shouldParseSymbols = !existing || existing.size !== stat.size || existing.mtimeMs !== stat.mtimeMs;
    if (!shouldParseSymbols) {
      skippedFiles += 1;
    }
    reporter.update({ scope, phase: "parse", status: "progress", current: processed, total, file: relativePath, module: detectModule(relativePath) });
    const source = shouldParseSymbols && (language === "php" || language === "javascript" || language === "typescript") ? await fs.readFile(absolutePath, "utf8") : "";
    let symbols: SymbolRecord[] = [];
    let moduleUsages: ModuleUsageRecord[] = [];
    let ormEntities: OrmEntityRecord[] = [];
    let ormUsages: OrmUsageRecord[] = [];
    let iblockUsages: IblockUsageRecord[] = [];
    let hlblockUsages: HlblockUsageRecord[] = [];
    let optionUsages: OptionUsageRecord[] = [];
    if (shouldParseSymbols && language === "php") {
      const result = parsePhpSymbolsWithDiagnostics(source, absolutePath);
      symbols = result.symbols;
      moduleUsages = result.moduleUsages;
      ormEntities = result.ormEntities;
      ormUsages = result.ormUsages;
      iblockUsages = result.iblockUsages;
      hlblockUsages = result.hlblockUsages;
      optionUsages = result.optionUsages;
      warnings.push(...result.warnings);
      if (debugParse) {
        for (const warning of result.warnings) {
          console.warn(`[bitrix-mcp] PHP parse fallback: ${warning.file}: ${warning.message}`);
        }
      }
    } else if (shouldParseSymbols && (language === "javascript" || language === "typescript")) {
      symbols = parseJsSymbols(source, absolutePath);
    }
    files.push({
      path: absolutePath,
      relativePath,
      kind: options.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
      symbols: symbols.map((symbol) => ({ ...symbol, language: symbol.language ?? language })),
      moduleUsages: moduleUsages.map((usage) => ({ ...usage, kind: options.kind, relativeFile: relativePath })),
      ormEntities: ormEntities.map((entity) => ({ ...entity, kind: options.kind, relativeFile: relativePath })),
      ormUsages: ormUsages.map((usage) => ({ ...usage, kind: options.kind, relativeFile: relativePath })),
      iblockUsages: iblockUsages.map((usage) => ({ ...usage, kind: options.kind, relativeFile: relativePath })),
      hlblockUsages: hlblockUsages.map((usage) => ({ ...usage, kind: options.kind, relativeFile: relativePath })),
      optionUsages: optionUsages.map((usage) => ({ ...usage, kind: options.kind, relativeFile: relativePath }))
    });
    symbolCount += symbols.length;
    relationCount += moduleUsages.length + ormUsages.length + iblockUsages.length + hlblockUsages.length + optionUsages.length + ormEntities.length;
  }
  reporter.done({ scope, phase: "parse", status: "done", symbols: symbolCount, relations: relationCount });

  const manifest: IndexManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: options.kind,
    files,
    warnings
  };

  reporter.start({ scope, phase: "write", status: "start", message: "Write index" });
  await writeIndexToSqlite(dbFile, manifest, { force: options.force });
  reporter.done({ scope, phase: "write", status: "done" });
  if (options.kind === "project") {
    await indexAutoloadMetadata(root, dbFile);
  }
  reporter.done({
    scope,
    phase: "done",
    status: "done",
    elapsedMs: Date.now() - startedAt,
    indexedFiles: files.length,
    skippedFiles,
    symbols: symbolCount,
    relations: relationCount
  });
  // Return the in-memory manifest built during this run. Callers only need
  // file counts / freshly parsed symbols, so we avoid re-reading the entire
  // index back from SQLite (a per-file query fan-out that cost minutes on
  // large scopes). Unchanged files stay fully indexed in SQLite either way.
  return manifest;
}

export async function readIndex(indexFile: string, kind?: IndexKind): Promise<IndexManifest | undefined> {
  if (kind) {
    const sqliteIndex = await readIndexFromSqlite(sqlitePath(path.dirname(indexFile)), kind);
    if (sqliteIndex) {
      return sqliteIndex;
    }
  }
  try {
    return JSON.parse(await fs.readFile(indexFile, "utf8")) as IndexManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
