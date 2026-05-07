import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  workspaceRoot: string;
  dataDir: string;
  docsDir: string;
  docsPaths: string[];
  bitrixRoot?: string;
  embeddingsUrl: string;
  semanticEnabled: boolean;
  officialDocsEnabled?: boolean;
}

export function resolveRuntimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  const workspaceRoot = path.resolve(overrides.workspaceRoot ?? process.env.BITRIX_MCP_WORKSPACE ?? process.cwd());
  const dataDir = path.resolve(overrides.dataDir ?? process.env.BITRIX_MCP_DATA_DIR ?? path.join(workspaceRoot, ".bitrix-mcp"));
  const envDocsPaths = parseDelimitedPaths(process.env.BITRIX_MCP_DOCS_PATHS);
  const docsDir = path.resolve(overrides.docsDir ?? process.env.BITRIX_MCP_DOCS_DIR ?? envDocsPaths[0] ?? path.join(workspaceRoot, "docs"));
  const docsPaths = normalizeDocsPaths(overrides.docsPaths ?? (envDocsPaths.length > 0 ? envDocsPaths : [docsDir]));
  const explicitBitrixRoot = overrides.bitrixRoot ?? process.env.BITRIX_ROOT;
  const bitrixRoot = explicitBitrixRoot ?? detectWorkspaceBitrixRoot(workspaceRoot);
  const embeddingsUrl = overrides.embeddingsUrl ?? process.env.BITRIX_MCP_EMBEDDINGS_URL ?? "http://127.0.0.1:8765";
  const semanticEnabled = overrides.semanticEnabled ?? parseBooleanEnv(process.env.BITRIX_MCP_SEMANTIC_ENABLED);
  const officialDocsEnabled = overrides.officialDocsEnabled ?? parseBooleanEnv(process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED, true);

  return {
    workspaceRoot,
    dataDir,
    docsDir,
    docsPaths,
    bitrixRoot: bitrixRoot ? resolveBitrixProjectRoot(bitrixRoot) : undefined,
    embeddingsUrl,
    semanticEnabled,
    officialDocsEnabled
  };
}

function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseDelimitedPaths(value: string | undefined): string[] {
  return value?.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function normalizeDocsPaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

export function resolveBitrixProjectRoot(root: string): string {
  const resolvedRoot = path.resolve(root.replace(/^~(?=$|\/|\\)/, os.homedir()));
  if (path.basename(resolvedRoot).toLowerCase() !== "bitrix") {
    return resolvedRoot;
  }

  try {
    return fs.statSync(resolvedRoot).isDirectory() ? path.dirname(resolvedRoot) : resolvedRoot;
  } catch {
    return resolvedRoot;
  }
}

function detectWorkspaceBitrixRoot(workspaceRoot: string): string | undefined {
  const bitrixDir = path.join(workspaceRoot, "bitrix");
  if (!fs.existsSync(bitrixDir)) {
    return undefined;
  }

  return fs.statSync(bitrixDir).isDirectory() ? workspaceRoot : undefined;
}

export function indexPath(dataDir: string, kind: string): string {
  return path.join(dataDir, `${kind}-index.json`);
}

export function sqlitePath(dataDir: string): string {
  return path.join(dataDir, "bitrix-mcp.sqlite");
}

export function docsSourcesDir(dataDir: string): string {
  return path.join(dataDir, "docs-sources");
}

export function frameworkDocsCheckoutPath(dataDir: string): string {
  return path.join(docsSourcesDir(dataDir), "framework-docs");
}
