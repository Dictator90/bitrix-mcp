import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { detectLanguage } from "./language.js";
import { parsePhpSymbols } from "../liveapi/phpParser.js";
import type { IndexFile, IndexKind, IndexManifest } from "../types.js";

const DEFAULT_PATTERNS = ["**/*.{php,js,jsx,ts,tsx,css,scss,sass,less,html,htm,xml,json,md,txt}"];
const DEFAULT_IGNORES = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.bitrix-mcp/**", "**/upload/**", "**/cache/**"];
const TEMPLATE_HINTS = ["local/templates/**", "bitrix/templates/**", "templates/**"];

export interface IndexOptions {
  root: string;
  kind: IndexKind;
  outFile: string;
  patterns?: string[];
}

async function loadIgnore(root: string) {
  const ig = ignore().add(DEFAULT_IGNORES.map((entry) => entry.replace(/^\*\*\//, "")));
  try {
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    ig.add(gitignore);
  } catch {
    // Optional file.
  }
  return ig;
}

export async function buildIndex(options: IndexOptions): Promise<IndexManifest> {
  const root = path.resolve(options.root);
  const patterns = options.patterns ?? (options.kind === "template" ? TEMPLATE_HINTS : DEFAULT_PATTERNS);
  const ig = await loadIgnore(root);
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
    const source = language === "php" ? await fs.readFile(absolutePath, "utf8") : "";
    files.push({
      path: absolutePath,
      relativePath,
      kind: options.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
      symbols: language === "php" ? parsePhpSymbols(source, absolutePath) : []
    });
  }

  const manifest: IndexManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    kind: options.kind,
    files
  };

  await fs.mkdir(path.dirname(options.outFile), { recursive: true });
  await fs.writeFile(options.outFile, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export async function readIndex(indexFile: string): Promise<IndexManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(indexFile, "utf8")) as IndexManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
