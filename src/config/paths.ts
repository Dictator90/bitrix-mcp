import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  workspaceRoot: string;
  dataDir: string;
  docsDir: string;
  bitrixRoot?: string;
  embeddingsUrl: string;
}

export function resolveRuntimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  const workspaceRoot = path.resolve(overrides.workspaceRoot ?? process.env.BITRIX_MCP_WORKSPACE ?? process.cwd());
  const dataDir = path.resolve(overrides.dataDir ?? process.env.BITRIX_MCP_DATA_DIR ?? path.join(workspaceRoot, ".bitrix-mcp"));
  const docsDir = path.resolve(overrides.docsDir ?? process.env.BITRIX_MCP_DOCS_DIR ?? path.join(workspaceRoot, "docs"));
  const explicitBitrixRoot = overrides.bitrixRoot ?? process.env.BITRIX_ROOT;
  const bitrixRoot = explicitBitrixRoot ?? detectWorkspaceBitrixRoot(workspaceRoot);
  const embeddingsUrl = overrides.embeddingsUrl ?? process.env.BITRIX_MCP_EMBEDDINGS_URL ?? "http://127.0.0.1:8765";

  return {
    workspaceRoot,
    dataDir,
    docsDir,
    bitrixRoot: bitrixRoot ? resolveBitrixProjectRoot(bitrixRoot) : undefined,
    embeddingsUrl
  };
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
