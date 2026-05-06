import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fg from "fast-glob";
import { frameworkDocsCheckoutPath, sqlitePath } from "../config/paths.js";
import { ensureSqliteStore, writeDocsToSqlite, type DocIndexChunk } from "../indexer/sqliteStore.js";
import type { DocResource, DocSource } from "../types.js";

export const OFFICIAL_DOCS_GIT_URL = "https://github.com/bitrix-tools/framework-docs.git";

const DOC_CHUNK_SIZE = 1800;
const DOC_CHUNK_OVERLAP = 200;

interface DocSourceRow {
  id: number;
  type: "git" | "path";
  uri: string;
  root_path: string | null;
  checkout_path: string | null;
  name: string | null;
  created_at: string;
  updated_at: string;
}

interface DocResourceRow {
  uri: string;
  title: string | null;
  path: string | null;
  mime_type: string | null;
  source_name: string | null;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function sourceNameForPath(root: string, index?: number): string {
  const basename = path.basename(root) || "local-docs";
  return index == null ? basename : `${basename}-${index + 1}`;
}

function expandHome(value: string): string {
  return path.resolve(value.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? "~"));
}

function rowToSource(row: DocSourceRow): DocSource {
  return {
    id: row.id,
    type: row.type,
    uri: row.uri,
    rootPath: row.root_path ?? undefined,
    checkoutPath: row.checkout_path ?? undefined,
    name: row.name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sourceDisplayName(source: DocSource): string {
  if (source.name) return source.name;
  if (source.uri === OFFICIAL_DOCS_GIT_URL) return "framework-docs";
  if (source.type === "path" && source.rootPath) return path.basename(source.rootPath) || source.rootPath;
  return source.type === "git" ? "git-docs" : "docs";
}

function sourceUriPrefix(source: DocSource): string {
  if (source.uri === OFFICIAL_DOCS_GIT_URL) return "framework-docs";
  return `${source.type}-${source.id}`;
}

function encodeRelativeUri(relativePath: string): string {
  return relativePath.split(/[\\/]/).map(encodeURIComponent).join("/");
}

function mimeTypeFor(relativePath: string): string {
  return relativePath.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";
}

function resourceName(source: DocSource, relativePath: string): string {
  const sourceName = sourceDisplayName(source);
  const fileName = relativePath.replace(/\.(md|txt)$/i, "").replace(/[\\/]/g, " / ");
  return `${sourceName} / ${fileName}`;
}

function titleFromText(text: string, fallback: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1].trim() ?? fallback;
}

function splitDocChunks(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += DOC_CHUNK_SIZE - DOC_CHUNK_OVERLAP) {
    chunks.push(normalized.slice(start, start + DOC_CHUNK_SIZE).trim());
  }
  return chunks.filter(Boolean);
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function gitCheckoutRoot(dataDir: string, url: string, requestedCheckoutPath?: string): Promise<string> {
  if (requestedCheckoutPath) return expandHome(requestedCheckoutPath);
  if (url === OFFICIAL_DOCS_GIT_URL) return frameworkDocsCheckoutPath(dataDir);
  const safeName = url.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).pop()?.replace(/[^a-z0-9._-]+/gi, "-") || "git-docs";
  return path.join(path.dirname(frameworkDocsCheckoutPath(dataDir)), safeName);
}

export async function addGitDocSource(dataDir: string, url = OFFICIAL_DOCS_GIT_URL, checkoutPath?: string, name?: string): Promise<DocSource> {
  await ensureSqliteStore(sqlitePath(dataDir));
  const now = new Date().toISOString();
  const checkoutRoot = await gitCheckoutRoot(dataDir, url, checkoutPath);
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const row = db.prepare(`
      INSERT INTO doc_sources (type, uri, root_path, checkout_path, name, created_at, updated_at)
      VALUES ('git', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(type, uri) DO UPDATE SET
        root_path = excluded.root_path,
        checkout_path = excluded.checkout_path,
        name = coalesce(excluded.name, doc_sources.name),
        updated_at = excluded.updated_at
      RETURNING id, type, uri, root_path, checkout_path, name, created_at, updated_at
    `).get(url, checkoutRoot, checkoutRoot, nullable(name), now, now) as unknown as DocSourceRow;
    return rowToSource(row);
  } finally {
    db.close();
  }
}

export async function addPathDocSource(dataDir: string, docsPath: string, name?: string): Promise<DocSource> {
  const root = expandHome(docsPath);
  if (!(await directoryExists(root))) {
    throw new Error(`Documentation path does not exist or is not a directory: ${root}`);
  }
  await ensureSqliteStore(sqlitePath(dataDir));
  const now = new Date().toISOString();
  const sourceName = name ?? sourceNameForPath(root);
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const row = db.prepare(`
      INSERT INTO doc_sources (type, uri, root_path, checkout_path, name, created_at, updated_at)
      VALUES ('path', ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(type, uri) DO UPDATE SET
        root_path = excluded.root_path,
        name = excluded.name,
        updated_at = excluded.updated_at
      RETURNING id, type, uri, root_path, checkout_path, name, created_at, updated_at
    `).get(root, root, sourceName, now, now) as unknown as DocSourceRow;
    return rowToSource(row);
  } finally {
    db.close();
  }
}

export async function addPathDocSources(dataDir: string, docsPaths: string[]): Promise<DocSource[]> {
  const sources: DocSource[] = [];
  for (const [index, docsPath] of docsPaths.entries()) {
    const root = expandHome(docsPath);
    if (await directoryExists(root)) {
      sources.push(await addPathDocSource(dataDir, root, sourceNameForPath(root, docsPaths.length > 1 ? index : undefined)));
    }
  }
  return sources;
}

export async function listDocSources(dataDir: string): Promise<DocSource[]> {
  try {
    await fs.access(sqlitePath(dataDir));
  } catch {
    return [];
  }
  await ensureSqliteStore(sqlitePath(dataDir));
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const rows = db.prepare("SELECT id, type, uri, root_path, checkout_path, name, created_at, updated_at FROM doc_sources ORDER BY id").all() as unknown as DocSourceRow[];
    return rows.map(rowToSource);
  } finally {
    db.close();
  }
}

export async function updateDocSources(dataDir: string): Promise<DocSource[]> {
  const sources = await listDocSources(dataDir);
  const gitSources = sources.filter((source) => source.type === "git");
  for (const source of gitSources) {
    const checkoutRoot = source.checkoutPath ?? await gitCheckoutRoot(dataDir, source.uri);
    if (await directoryExists(path.join(checkoutRoot, ".git"))) {
      await runGit(["pull", "--ff-only"], checkoutRoot);
    } else {
      await fs.mkdir(path.dirname(checkoutRoot), { recursive: true });
      await runGit(["clone", source.uri, checkoutRoot]);
    }
  }
  return gitSources;
}

async function docsFromSource(source: DocSource): Promise<DocResource[]> {
  const root = source.rootPath ?? source.checkoutPath;
  if (!root) return [];
  const files = await fg(["**/*.{md,txt}"], { cwd: root, onlyFiles: true, dot: false }).catch(() => [] as string[]);
  return files.sort().map((relativePath) => {
    const name = resourceName(source, relativePath);
    return {
      uri: `bitrix-docs://${sourceUriPrefix(source)}/${encodeRelativeUri(relativePath)}`,
      name,
      description: `Bitrix Framework documentation: ${name}`,
      mimeType: mimeTypeFor(relativePath),
      path: path.join(root, relativePath)
    };
  });
}

export async function listDocResources(dataDir: string): Promise<DocResource[]> {
  try {
    await fs.access(sqlitePath(dataDir));
  } catch {
    return [];
  }
  await ensureSqliteStore(sqlitePath(dataDir));
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const rows = db.prepare("SELECT uri, title, path, mime_type, source_name FROM docs ORDER BY uri").all() as unknown as DocResourceRow[];
    return rows.map((row) => {
      const name = row.title ?? row.uri.replace(/^bitrix-docs:\/\//, "").replace(/\.(md|txt)$/i, "").replace(/[\\/]/g, " / ");
      const descriptionSource = row.source_name ? `${row.source_name}: ` : "";
      return {
        uri: row.uri,
        name,
        description: `Bitrix Framework documentation: ${descriptionSource}${name}`,
        mimeType: row.mime_type ?? "text/plain",
        path: row.path ?? ""
      };
    });
  } finally {
    db.close();
  }
}

export async function readDocResource(dataDir: string, uri: string): Promise<{ contents: string; resource: DocResource }> {
  const resources = await listDocResources(dataDir);
  const resource = resources.find((entry) => entry.uri === uri);
  if (!resource || !resource.path) {
    throw new Error(`Unknown documentation resource: ${uri}`);
  }
  return { contents: await fs.readFile(resource.path, "utf8"), resource };
}

export async function indexDocResourcesToSqlite(dataDir: string, docsPaths: string[] = []): Promise<number> {
  if (docsPaths.length > 0) {
    await addPathDocSources(dataDir, docsPaths);
  }
  const sources = await listDocSources(dataDir);
  const chunks: DocIndexChunk[] = [];
  for (const source of sources) {
    const resources = await docsFromSource(source);
    for (const resource of resources) {
      const contents = await fs.readFile(resource.path, "utf8");
      const title = titleFromText(contents, resource.name);
      splitDocChunks(contents).forEach((text, chunkIndex) => {
        chunks.push({
          uri: resource.uri,
          sourceId: source.id,
          sourceName: sourceDisplayName(source),
          title,
          path: resource.path,
          mimeType: resource.mimeType,
          chunkIndex,
          text
        });
      });
    }
  }
  await writeDocsToSqlite(sqlitePath(dataDir), chunks);
  return chunks.length;
}
