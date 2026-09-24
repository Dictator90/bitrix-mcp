import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { SECRET_FILE_PATTERNS } from "../config/secrets.js";
import { sqlitePath } from "../config/paths.js";
import { parseJsSymbols } from "../liveapi/jsParser.js";
import { parsePhpSymbolsWithDiagnostics } from "../liveapi/phpParser.js";
import { detectLanguage } from "./language.js";
import { readIndexFromSqlite, SqliteIndexWriter } from "./sqliteStore.js";
import { indexAutoloadMetadata } from "./autoload.js";
import { NoopProgressReporter } from "../progress/noopReporter.js";
import type { IndexProgressEvent, IndexScope, ProgressReporter } from "../progress/types.js";
import type { IndexFile, IndexKind, IndexManifest, IndexWarning, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";

const CODE_EXTENSIONS = "{php,js,jsx,ts,tsx,css,scss,sass,less,html,htm,xml,json,md,txt}";
export const DEFAULT_INDEX_PATTERNS = [`**/*.${CODE_EXTENSIONS}`];
// `dist/` is built bundle output (transpiled IIFE bundles yield no usable class
// symbols); the authored `src/` next to it is indexed instead. `test/` dirs and
// `*.test.js` are test scaffolding, not API surface, so they are excluded from
// every scope.
const DEFAULT_IGNORES = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.bitrix-mcp/**", "**/upload/**", "**/cache/**", "**/generated/**", "**/test/**", "**/*.test.js"];
// The project scope indexes the project's own code only. The entire bitrix/
// core tree is owned by the dedicated bitrix scope (modules/admin/tools/js)
// and the template scope (components/templates), so it is excluded here to
// avoid crawling tens of thousands of core files (wizards, admin, js, ...).
const PROJECT_KIND_IGNORES = [
  "bitrix/**",
  "local/modules/**",
  "local/templates/**",
  "local/components/**",
  "local/js/**",
];
// JS source under bitrix/js carries the core frontend <-> logic bindings.
const BITRIX_JS_EXTENSIONS = "{js,jsx,ts,tsx}";
// Structural exclusion only (install assets are a separate scope). The lang
// policy is owned by the Bitrix policy resolver (resolveBitrixIndex) so that
// `--include-lang` / `--full` can re-enable it; CLI/actions pass it explicitly.
const BITRIX_KIND_IGNORES = ["bitrix/modules/*/install/**", "local/modules/*/install/**"];
// Extension JS under a module's `install/js` is copied verbatim into the
// published `bitrix/js` tree when the module installs, so it duplicates what the
// bitrix scope already indexes. Skip it in the install-assets scope to avoid
// double-indexing the same symbols under two kinds.
const INSTALL_KIND_IGNORES = ["bitrix/modules/*/install/js/**", "local/modules/*/install/js/**"];
export const DEFAULT_TEMPLATE_PATTERNS = [
  `bitrix/templates/**/*.${CODE_EXTENSIONS}`,
  `local/templates/**/*.${CODE_EXTENSIONS}`,
  `bitrix/components/**/*.${CODE_EXTENSIONS}`,
  `local/components/**/*.${CODE_EXTENSIONS}`
];
// Curated Bitrix core allowlist: module/admin/tools PHP plus core JS. Runtime,
// static assets, lang, and install are excluded (via patterns + BITRIX_KIND_IGNORES).
// Components/templates are owned by the template scope.
export const DEFAULT_BITRIX_PATTERNS = [
  "bitrix/modules/**/*.php",
  "bitrix/admin/**/*.php",
  "bitrix/tools/**/*.php",
  `bitrix/js/**/*.${BITRIX_JS_EXTENSIONS}`,
  "local/modules/**/*.php",
  `local/js/**/*.${BITRIX_JS_EXTENSIONS}`,
];
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
  /** Index `lang/` message-file directories. Defaults to false (excluded). */
  includeLang?: boolean;
  /**
   * Base directory for stored relative paths, when `root` is a subdirectory
   * being re-indexed (e.g. one template). Defaults to `root`. Only files under
   * `root` are pruned from the index.
   */
  relativeTo?: string;
  /**
   * Keep parsed symbols in the returned manifest (default true). Long runs pass
   * false so parsed files are released after each write batch.
   */
  retainSymbols?: boolean;
}

/**
 * Base directory for relative paths when re-indexing `root`: the workspace when
 * `root` is inside it (so paths match a full run), otherwise `root` itself.
 */
export function relativeBaseFor(workspaceRoot: string, root: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(root));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? path.resolve(workspaceRoot) : path.resolve(root);
}

/** Files parsed between SQLite write transactions. */
const WRITE_BATCH_SIZE = 250;

// Bitrix i18n message files live in `lang/` directories across modules,
// components and templates. They are huge and rarely useful for code search,
// so they are excluded from every scope by default (override with --include-lang).
const LANG_IGNORES = ["**/lang/**"];

/** Extract the Bitrix module name from a path like `bitrix/modules/iblock/lib/...`. */
function detectModule(relativePath: string): string | undefined {
  const match = relativePath.replace(/\\/g, "/").match(/(?:^|\/)(?:bitrix|local)\/modules\/([^/]+)\//);
  return match?.[1];
}

async function loadIgnore(root: string, options: { useGitignore?: boolean; extraIgnores?: string[] } = {}) {
  const ig = ignore().add(SECRET_FILE_PATTERNS).add([...DEFAULT_IGNORES, ...(options.extraIgnores ?? [])].map((entry) => entry.replace(/^\*\*\//, "")));
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
  if (kind === "install") return INSTALL_KIND_IGNORES;
  return [];
}

export interface DiscoverFilesOptions {
  kind: IndexKind;
  patterns?: string[];
  ignores?: string[];
  includeLang?: boolean;
}

export interface DiscoverFilesResult {
  /** All files matched by the glob patterns before ignore filtering. */
  found: string[];
  /** Files remaining after built-in, kind, .gitignore and .bitrixmcpignore rules. */
  queued: string[];
}

/**
 * Glob + ignore discovery, shared by buildIndex and the `--plan` dry-run so the
 * plan reflects exactly what would be indexed (same patterns and ignore rules).
 */
export async function discoverFiles(root: string, options: DiscoverFilesOptions): Promise<DiscoverFilesResult> {
  const resolvedRoot = path.resolve(root);
  const patterns = options.patterns ?? defaultPatternsForKind(options.kind);
  const kindIgnores = [
    ...defaultIgnoresForKind(options.kind),
    ...(options.includeLang ? [] : LANG_IGNORES),
    ...(options.ignores ?? [])
  ];
  const ig = await loadIgnore(resolvedRoot, {
    useGitignore: options.kind !== "bitrix" && options.kind !== "install",
    extraIgnores: kindIgnores
  });
  const found = await fg(patterns, {
    cwd: resolvedRoot,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...DEFAULT_IGNORES, ...kindIgnores]
  });
  const queued = found.filter((relativePath) => !ig.ignores(relativePath)).sort();
  return { found, queued };
}

export async function buildIndex(options: IndexOptions): Promise<IndexManifest> {
  const startedAt = Date.now();
  const reporter = options.reporter ?? new NoopProgressReporter();
  const scope: IndexScope = options.scope ?? options.kind;
  const root = path.resolve(options.root);
  const baseRoot = path.resolve(options.relativeTo ?? root);
  const retainSymbols = options.retainSymbols ?? true;
  const dbFile = options.dbFile ?? sqlitePath(path.dirname(options.outFile ?? path.join(root, ".bitrix-mcp", "legacy-index.json")));
  const generatedAt = new Date().toISOString();

  reporter.start({ scope, phase: "discover", status: "start", startedAt });
  const { found, queued } = await discoverFiles(root, { kind: options.kind, patterns: options.patterns, ignores: options.ignores, includeLang: options.includeLang });
  reporter.done({
    scope,
    phase: "discover",
    status: "done",
    foundFiles: found.length,
    ignoredFiles: found.length - queued.length,
    queuedFiles: queued.length
  });

  const writer = await SqliteIndexWriter.open(dbFile, {
    kind: options.kind,
    root: baseRoot,
    scanRoot: root,
    currentPaths: queued.map((relativePath) => path.join(root, relativePath)),
    force: options.force,
    generatedAt
  });

  const files: IndexFile[] = [];
  const warnings: IndexWarning[] = [];
  const debugParse = process.env.BITRIX_MCP_DEBUG_PARSE === "1";
  let symbolCount = 0;
  let relationCount = 0;
  let skippedFiles = 0;
  let batch: IndexFile[] = [];
  const total = queued.length;
  const flush = () => {
    writer.writeFiles(batch);
    batch = [];
  };

  try {
    reporter.start({ scope, phase: "parse", status: "start", message: "Parse files", total, startedAt: Date.now() });
    let processed = 0;
    for (const scanRelativePath of queued) {
      processed += 1;
      const absolutePath = path.join(root, scanRelativePath);
      const relativePath = baseRoot === root ? scanRelativePath : path.relative(baseRoot, absolutePath).replace(/\\/gu, "/");
      reporter.update({ scope, phase: "parse", status: "progress", current: processed, total, file: relativePath, module: detectModule(relativePath) });

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        // Removed between discovery and parsing: leave it out; the next run prunes it.
        warnings.push({ type: "file_error", file: absolutePath, message: `Skipped: ${(error as Error).message}` });
        continue;
      }
      const language = detectLanguage(absolutePath);
      const unchanged = writer.isUnchanged(absolutePath, stat.size, stat.mtimeMs);
      const indexFile: IndexFile = { path: absolutePath, relativePath, kind: options.kind, size: stat.size, mtimeMs: stat.mtimeMs, language, symbols: [] };
      if (unchanged) {
        skippedFiles += 1;
        files.push(indexFile);
        continue;
      }

      try {
        const parsed = await parseFile(absolutePath, language);
        warnings.push(...parsed.warnings);
        if (debugParse) {
          for (const warning of parsed.warnings) {
            console.warn(`[bitrix-mcp] PHP parse fallback: ${warning.file}: ${warning.message}`);
          }
        }
        const withContext = <T extends object>(records: T[]) => records.map((record) => ({ ...record, kind: options.kind, relativeFile: relativePath }));
        indexFile.symbols = parsed.symbols.map((symbol) => ({ ...symbol, language: symbol.language ?? language }));
        indexFile.moduleUsages = withContext(parsed.moduleUsages);
        indexFile.ormEntities = withContext(parsed.ormEntities);
        indexFile.ormUsages = withContext(parsed.ormUsages);
        indexFile.iblockUsages = withContext(parsed.iblockUsages);
        indexFile.hlblockUsages = withContext(parsed.hlblockUsages);
        indexFile.optionUsages = withContext(parsed.optionUsages);
        symbolCount += parsed.symbols.length;
        relationCount += parsed.moduleUsages.length + parsed.ormUsages.length + parsed.iblockUsages.length + parsed.hlblockUsages.length + parsed.optionUsages.length + parsed.ormEntities.length;
      } catch (error) {
        // One unreadable or unparsable file must not abort the whole run: index it without symbols.
        warnings.push({ type: "file_error", file: absolutePath, message: `Parse failed: ${(error as Error).message}` });
      }

      batch.push(indexFile);
      files.push(retainSymbols ? indexFile : { ...indexFile, symbols: [], moduleUsages: undefined, ormEntities: undefined, ormUsages: undefined, iblockUsages: undefined, hlblockUsages: undefined, optionUsages: undefined });
      if (batch.length >= WRITE_BATCH_SIZE) flush();
    }
    reporter.done({ scope, phase: "parse", status: "done", symbols: symbolCount, relations: relationCount });

    reporter.start({ scope, phase: "write", status: "start", message: "Write index" });
    flush();
    writer.finish({ files: files.length, warnings });
    reporter.done({ scope, phase: "write", status: "done" });
  } finally {
    writer.close();
  }

  const manifest: IndexManifest = {
    version: 1,
    generatedAt,
    root: baseRoot,
    kind: options.kind,
    files,
    warnings
  };

  if (options.kind === "project" && baseRoot === root) {
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
  // Return the in-memory manifest built during this run (without re-reading the
  // index from SQLite). Unchanged files carry no symbols; they stay fully indexed
  // in SQLite either way.
  return manifest;
}

interface ParsedFile {
  symbols: SymbolRecord[];
  moduleUsages: ModuleUsageRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
  warnings: IndexWarning[];
}

async function parseFile(absolutePath: string, language: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], warnings: [] };
  if (language === "php") {
    const result = parsePhpSymbolsWithDiagnostics(await fs.readFile(absolutePath, "utf8"), absolutePath);
    return { ...empty, ...result, warnings: result.warnings };
  }
  if (language === "javascript" || language === "typescript") {
    return { ...empty, symbols: parseJsSymbols(await fs.readFile(absolutePath, "utf8"), absolutePath) };
  }
  return empty;
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
