import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { sqlitePath } from "../config/paths.js";
import { parseJsSymbols } from "../liveapi/jsParser.js";
import { parsePhpSymbols } from "../liveapi/phpParser.js";
import { detectLanguage } from "./language.js";
import { readExistingFilesByKind, readIndexFromSqlite, writeIndexToSqlite } from "./sqliteStore.js";
import type { IndexFile, IndexKind, IndexManifest } from "../types.js";

export const DEFAULT_INDEX_PATTERNS = ["**/*.{php,js,jsx,ts,tsx,css,scss,sass,less,html,htm,xml,json,md,txt}"];
const DEFAULT_IGNORES = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.bitrix-mcp/**", "**/upload/**", "**/cache/**"];
const TEMPLATE_HINTS = ["local/templates/**", "bitrix/templates/**"];

export interface IndexOptions {
  root: string;
  kind: IndexKind;
  outFile?: string;
  dbFile?: string;
  patterns?: string[];
  force?: boolean;
}

async function loadIgnore(root: string, options: { useGitignore?: boolean } = {}) {
  const ig = ignore().add(DEFAULT_IGNORES.map((entry) => entry.replace(/^\*\*\//, "")));
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

export async function buildIndex(options: IndexOptions): Promise<IndexManifest> {
  const root = path.resolve(options.root);
  const patterns = options.patterns ?? (options.kind === "template" ? TEMPLATE_HINTS : DEFAULT_INDEX_PATTERNS);
  const dbFile = options.dbFile ?? sqlitePath(path.dirname(options.outFile ?? path.join(root, ".bitrix-mcp", "legacy-index.json")));
  const existingFiles = options.force ? [] : await readExistingFilesByKind(dbFile, options.kind);
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
  const ig = await loadIgnore(root, {
    useGitignore: options.kind !== "bitrix" && options.kind !== "install"
  });
  const entries = await fg(patterns, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORES
  });

  const files: IndexFile[] = [];
  for (const relativePath of entries.sort()) {
    if (ig.ignores(relativePath)) {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.stat(absolutePath);
    const language = detectLanguage(absolutePath);
    const existing = existingByPath.get(absolutePath);
    const shouldParseSymbols = !existing || existing.size !== stat.size || existing.mtimeMs !== stat.mtimeMs;
    const source = shouldParseSymbols && (language === "php" || language === "javascript" || language === "typescript") ? await fs.readFile(absolutePath, "utf8") : "";
    const symbols = shouldParseSymbols ? language === "php" ? parsePhpSymbols(source, absolutePath) : language === "javascript" || language === "typescript" ? parseJsSymbols(source, absolutePath) : [] : [];
    files.push({
      path: absolutePath,
      relativePath,
      kind: options.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
      symbols: symbols.map((symbol) => ({ ...symbol, language: symbol.language ?? language }))
    });
  }

  const manifest: IndexManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: options.kind,
    files
  };

  await writeIndexToSqlite(dbFile, manifest, { force: options.force });
  return (await readIndexFromSqlite(dbFile, options.kind)) ?? manifest;
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
