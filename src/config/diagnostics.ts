import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqlitePath, type RuntimePaths } from "./paths.js";

export interface RuntimeConfigSummary {
  workspaceRoot: string;
  dataDir: string;
  sqlitePath: string;
  docsPaths: string[];
  bitrixRoot?: string;
  embeddingsUrl: string;
  semanticEnabled: boolean;
  officialDocsEnabled?: boolean;
  dbEnabled: boolean;
  dbAllowWrite: boolean;
  tinkerEnabled: boolean;
  phpBin: string;
}

export interface McpConfigFileStatus {
  client: string;
  path?: string;
  scope: "project" | "global" | "manual";
  exists: boolean;
  note?: string;
}

export interface ConfigDiagnostics {
  runtime: RuntimeConfigSummary;
  mcpConfigFiles: McpConfigFileStatus[];
}

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function summarizeRuntimePaths(paths: RuntimePaths): RuntimeConfigSummary {
  return {
    workspaceRoot: paths.workspaceRoot,
    dataDir: paths.dataDir,
    sqlitePath: sqlitePath(paths.dataDir),
    docsPaths: paths.docsPaths,
    bitrixRoot: paths.bitrixRoot,
    embeddingsUrl: paths.embeddingsUrl,
    semanticEnabled: paths.semanticEnabled,
    officialDocsEnabled: paths.officialDocsEnabled,
    dbEnabled: paths.dbEnabled,
    dbAllowWrite: paths.dbAllowWrite,
    tinkerEnabled: paths.tinkerEnabled,
    phpBin: paths.phpBin
  };
}

export async function listMcpConfigFiles(paths: RuntimePaths): Promise<McpConfigFileStatus[]> {
  const candidates: Omit<McpConfigFileStatus, "exists">[] = [
    { client: "Cursor", scope: "project", path: path.join(paths.workspaceRoot, ".cursor", "mcp.json") },
    { client: "Claude Code", scope: "project", path: path.join(paths.workspaceRoot, ".mcp.json") },
    { client: "VS Code / GitHub Copilot", scope: "project", path: path.join(paths.workspaceRoot, ".vscode", "mcp.json") },
    { client: "Windsurf", scope: "global", path: homePath(".codeium", "windsurf", "mcp_config.json") },
    { client: "Cline", scope: "global", path: homePath(".cline", "data", "settings", "cline_mcp_settings.json") },
    { client: "Roo Code", scope: "project", path: path.join(paths.workspaceRoot, ".roo", "mcp.json") },
    { client: "Continue", scope: "project", path: path.join(paths.workspaceRoot, ".continue", "mcpServers", "bitrix-mcp.json") },
    { client: "Gemini CLI", scope: "project", path: path.join(paths.workspaceRoot, ".gemini", "settings.json") },
    { client: "OpenAI Codex", scope: "global", path: homePath(".codex", "config.toml") },
    { client: "Kilo Code", scope: "global", path: homePath(".kilocode", "cli", "global", "settings", "mcp_settings.json") },
    { client: "PhpStorm / JetBrains", scope: "manual", note: "Configured through JetBrains IDE settings; bitrix-mcp init prints a JSON snippet instead of writing a known config file." }
  ];

  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    exists: candidate.path ? await fileExists(candidate.path) : false
  })));
}

export async function collectConfigDiagnostics(paths: RuntimePaths): Promise<ConfigDiagnostics> {
  return {
    runtime: summarizeRuntimePaths(paths),
    mcpConfigFiles: await listMcpConfigFiles(paths)
  };
}

export function formatConfigDiagnostics(diagnostics: ConfigDiagnostics): string {
  const runtime = diagnostics.runtime;
  const runtimeLines = [
    "Runtime paths:",
    `  workspaceRoot: ${runtime.workspaceRoot}`,
    `  dataDir: ${runtime.dataDir}`,
    `  sqlitePath: ${runtime.sqlitePath}`,
    `  docsPaths: ${runtime.docsPaths.length > 0 ? runtime.docsPaths.join(path.delimiter) : "(none)"}`,
    `  bitrixRoot: ${runtime.bitrixRoot ?? "(not detected)"}`,
    `  embeddingsUrl: ${runtime.embeddingsUrl}`,
    `  semanticEnabled: ${runtime.semanticEnabled}`,
    `  officialDocsEnabled: ${runtime.officialDocsEnabled}`,
    `  dbEnabled: ${runtime.dbEnabled}`,
    `  dbAllowWrite: ${runtime.dbAllowWrite}`,
    `  tinkerEnabled: ${runtime.tinkerEnabled}`,
    `  phpBin: ${runtime.phpBin}`
  ];
  const configLines = diagnostics.mcpConfigFiles.map((entry) => {
    const status = entry.exists ? "present" : "missing";
    const location = entry.path ?? entry.note ?? "no file path";
    return `  ${status} ${entry.client} [${entry.scope}]: ${location}`;
  });
  return [...runtimeLines, "", "MCP config files:", ...configLines].join("\n");
}
