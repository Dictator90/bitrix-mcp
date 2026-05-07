import fs from "node:fs/promises";
import path from "node:path";
import { indexPath, resolveBitrixProjectRoot, sqlitePath, type RuntimePaths } from "../config/paths.js";
import { EmbeddingsClient } from "../search/embeddingsClient.js";
import { buildIndex, type IndexOptions } from "./indexer.js";
import { getIndexStatus, ensureSqliteStore, type IndexStatus } from "./sqliteStore.js";
import { resolveTemplateIndexOptions } from "./template.js";
import { indexDocResourcesToSqlite, listDocSources } from "../resources/docs.js";

export interface IndexAllResult {
  projectFiles: number;
  templateFiles: number;
  bitrixFiles: number;
  installFiles: number;
  docChunks: number;
  dbFile: string;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

const CODE_EXTENSIONS = "{php,js,jsx,ts,tsx,css,scss,sass,less,html,htm,xml,json,md,txt}";
export const INSTALL_ASSET_PATTERNS = [
  `bitrix/modules/*/install/**/*.${CODE_EXTENSIONS}`,
  `local/modules/*/install/**/*.${CODE_EXTENSIONS}`
];

async function pathExists(targetPath: string): Promise<boolean> {
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

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

export async function indexCode(paths: RuntimePaths): Promise<Omit<IndexAllResult, "docChunks">> {
  const projectManifest = await buildIndex({ root: paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project") });
  const templateManifest = await buildIndex(resolveTemplateIndexOptions(paths));

  let bitrixFiles = 0;
  let installFiles = 0;
  if (paths.bitrixRoot) {
    const projectRoot = resolveBitrixProjectRoot(paths.bitrixRoot);
    const bitrixManifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: ["bitrix/modules/**/*.php", "local/modules/**/*.php"] });
    bitrixFiles = bitrixManifest.files.length;

    const installManifest = await buildIndex({ root: projectRoot, kind: "install", outFile: indexPath(paths.dataDir, "install"), patterns: INSTALL_ASSET_PATTERNS });
    installFiles = installManifest.files.length;
  }

  return {
    projectFiles: projectManifest.files.length,
    templateFiles: templateManifest.files.length,
    bitrixFiles,
    installFiles,
    dbFile: sqlitePath(paths.dataDir)
  };
}

export async function indexAll(paths: RuntimePaths): Promise<IndexAllResult> {
  const codeResult = await indexCode(paths);
  const docChunks = await indexDocResourcesToSqlite(paths.dataDir, paths.docsPaths, { includeOfficialDocs: paths.officialDocsEnabled ?? false });
  return { ...codeResult, docChunks };
}

export function installIndexOptions(paths: RuntimePaths, root?: string): IndexOptions {
  const projectRoot = resolveBitrixProjectRoot(root ?? paths.bitrixRoot ?? paths.workspaceRoot);
  return { root: projectRoot, kind: "install", outFile: indexPath(paths.dataDir, "install"), patterns: INSTALL_ASSET_PATTERNS };
}

export async function readIndexStatus(paths: RuntimePaths): Promise<IndexStatus> {
  return getIndexStatus(sqlitePath(paths.dataDir));
}

export async function runDoctor(paths: RuntimePaths): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(await directoryExists(paths.workspaceRoot)
    ? { name: "workspace", status: "ok", message: `Workspace exists: ${paths.workspaceRoot}` }
    : { name: "workspace", status: "error", message: `Workspace directory is not available: ${paths.workspaceRoot}` });

  if (paths.bitrixRoot) {
    const bitrixDir = path.join(paths.bitrixRoot, "bitrix");
    checks.push(await directoryExists(bitrixDir)
      ? { name: "bitrixRoot", status: "ok", message: `Bitrix root detected: ${paths.bitrixRoot}` }
      : { name: "bitrixRoot", status: "warning", message: `BITRIX_ROOT is set to ${paths.bitrixRoot}, but ${bitrixDir} is missing.` });
  } else {
    checks.push({ name: "bitrixRoot", status: "warning", message: "Bitrix root was not detected. Run from a project containing ./bitrix or set BITRIX_ROOT." });
  }

  const dbFile = sqlitePath(paths.dataDir);
  try {
    await ensureSqliteStore(dbFile);
    checks.push({ name: "sqliteDb", status: "ok", message: `SQLite DB is readable/writable: ${dbFile}` });
  } catch (error) {
    checks.push({ name: "sqliteDb", status: "error", message: `SQLite DB check failed for ${dbFile}: ${error instanceof Error ? error.message : String(error)}` });
  }

  const sources = await listDocSources(paths.dataDir);
  const docsPaths = [...new Set([...paths.docsPaths, ...sources.map((source) => source.rootPath ?? source.checkoutPath).filter((entry): entry is string => Boolean(entry))])];
  if (docsPaths.length === 0) {
    checks.push({ name: "docsSources", status: "warning", message: "No documentation paths or registered documentation sources found." });
  } else {
    const missingDocs = [];
    for (const docsPath of docsPaths) {
      if (!(await directoryExists(docsPath))) missingDocs.push(docsPath);
    }
    checks.push(missingDocs.length === 0
      ? { name: "docsSources", status: "ok", message: `Documentation sources available: ${docsPaths.join(", ")}` }
      : { name: "docsSources", status: "warning", message: `Missing documentation source directories: ${missingDocs.join(", ")}` });
  }

  const ignoreFile = path.join(paths.workspaceRoot, ".bitrixmcpignore");
  if (await pathExists(ignoreFile)) {
    checks.push(await fileExists(ignoreFile)
      ? { name: "bitrixmcpignore", status: "ok", message: `.bitrixmcpignore is present: ${ignoreFile}` }
      : { name: "bitrixmcpignore", status: "warning", message: `.bitrixmcpignore exists but is not a regular file: ${ignoreFile}` });
  } else {
    checks.push({ name: "bitrixmcpignore", status: "warning", message: `.bitrixmcpignore is not present in ${paths.workspaceRoot}; only built-in ignores and .gitignore will apply.` });
  }

  try {
    const health = await new EmbeddingsClient(paths.embeddingsUrl).health();
    checks.push(health.status === "ok"
      ? { name: "embeddingsService", status: "ok", message: `Embeddings service is healthy at ${paths.embeddingsUrl}${health.model ? ` (${health.model})` : ""}.` }
      : { name: "embeddingsService", status: "warning", message: `Embeddings service responded at ${paths.embeddingsUrl} with status ${health.status}.` });
  } catch (error) {
    checks.push({ name: "embeddingsService", status: "warning", message: `Embeddings service is unavailable at ${paths.embeddingsUrl}: ${error instanceof Error ? error.message : String(error)}` });
  }

  return checks;
}

export function formatIndexStatus(status: IndexStatus): string {
  return [
    `SQLite DB: ${status.dbFile}`,
    `Files: ${status.files}`,
    `Symbols: ${status.symbols}`,
    `Events: ${status.events}`,
    `Documents: ${status.documents}`,
    `Last indexed: ${status.lastIndexedAt ?? "never"}`
  ].join("\n");
}

export function formatIndexAllResult(result: IndexAllResult): string {
  return [
    `Indexed project files: ${result.projectFiles}`,
    `Indexed template files: ${result.templateFiles}`,
    `Indexed Bitrix module files: ${result.bitrixFiles}`,
    `Indexed install asset files: ${result.installFiles}`,
    `Indexed documentation chunks: ${result.docChunks}`,
    `SQLite DB: ${result.dbFile}`
  ].join("\n");
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.message}`).join("\n");
}

export function hasDoctorErrors(checks: DoctorCheck[]): boolean {
  return checks.some((check) => check.status === "error");
}
