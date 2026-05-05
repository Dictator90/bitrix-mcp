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
  const bitrixRoot = overrides.bitrixRoot ?? process.env.BITRIX_ROOT;
  const embeddingsUrl = overrides.embeddingsUrl ?? process.env.BITRIX_MCP_EMBEDDINGS_URL ?? "http://127.0.0.1:8765";

  return {
    workspaceRoot,
    dataDir,
    docsDir,
    bitrixRoot: bitrixRoot ? path.resolve(bitrixRoot.replace(/^~(?=$|\/|\\)/, os.homedir())) : undefined,
    embeddingsUrl
  };
}

export function indexPath(dataDir: string, kind: string): string {
  return path.join(dataDir, `${kind}-index.json`);
}
