import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fg from "fast-glob";
import { frameworkDocsCheckoutPath, sqlitePath } from "../config/paths.js";
import { ensureSqliteStore, readExistingDocsBySource, writeDocsToSqlite, type DocIndexChunk } from "../indexer/sqliteStore.js";
import type { DocResource, DocSource } from "../types.js";
import type { EmbeddingsDocument } from "../search/embeddingsClient.js";

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

interface ScannedDocResource extends DocResource {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function canonicalDocGitUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/u, "");
  if (/^(https?:\/\/github\.com\/|git@github\.com:)bitrix-tools\/framework-docs(?:\.git)?$/iu.test(normalized)) {
    return OFFICIAL_DOCS_GIT_URL;
  }
  return normalized;
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

interface MarkdownDocChunk {
  text: string;
  headingPath?: string;
  sectionAnchor?: string;
}

interface MarkdownSection {
  text: string;
  headingPath: string[];
  sectionAnchor?: string;
}

function markdownAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function markdownHeading(line: string): { level: number; title: string } | undefined {
  const match = line.match(/^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/u);
  if (!match) return undefined;
  return { level: match[1].length, title: match[2].trim() };
}

function splitMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.replace(/\r\n?/gu, "\n").trim().split("\n");
  const sections: MarkdownSection[] = [];
  const headingPath: string[] = [];
  let sectionLines: string[] = [];
  let currentHeadingPath: string[] = [];
  let currentAnchor: string | undefined;
  let inFence = false;

  const flush = () => {
    const sectionText = sectionLines.join("\n").trim();
    if (sectionText) {
      sections.push({ text: sectionText, headingPath: currentHeadingPath, sectionAnchor: currentAnchor });
    }
    sectionLines = [];
  };

  for (const line of lines) {
    if (/^ {0,3}```/u.test(line) || /^ {0,3}~~~/u.test(line)) {
      inFence = !inFence;
    }

    const heading = inFence ? undefined : markdownHeading(line);
    if (heading) {
      flush();
      headingPath[heading.level - 1] = heading.title;
      headingPath.length = heading.level;
      currentHeadingPath = [...headingPath];
      currentAnchor = markdownAnchor(heading.title);
    }

    sectionLines.push(line);
  }
  flush();
  return sections;
}

function splitLargeMarkdownSection(section: MarkdownSection): MarkdownDocChunk[] {
  if (section.text.length <= DOC_CHUNK_SIZE) {
    return [{ text: section.text, headingPath: section.headingPath.join(" > ") || undefined, sectionAnchor: section.sectionAnchor }];
  }

  const prefix = section.headingPath.length > 0 ? `Heading path: ${section.headingPath.join(" > ")}\n\n` : "";
  const chunks: MarkdownDocChunk[] = [];
  const blocks = section.text.split(/\n{2,}/u);
  let current = "";

  const pushCurrent = () => {
    const text = current.trim();
    if (text) {
      chunks.push({ text, headingPath: section.headingPath.join(" > ") || undefined, sectionAnchor: section.sectionAnchor });
    }
    current = "";
  };

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= DOC_CHUNK_SIZE) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (block.length <= DOC_CHUNK_SIZE) {
      current = prefix && !block.startsWith(prefix) ? `${prefix}${block}` : block;
      continue;
    }

    const chunkSize = Math.max(1, DOC_CHUNK_SIZE - prefix.length);
    const step = Math.max(1, chunkSize - DOC_CHUNK_OVERLAP);
    for (let start = 0; start < block.length; start += step) {
      const text = `${prefix}${block.slice(start, start + chunkSize)}`.trim();
      if (text) {
        chunks.push({ text, headingPath: section.headingPath.join(" > ") || undefined, sectionAnchor: section.sectionAnchor });
      }
    }
  }

  pushCurrent();
  return chunks.filter((chunk) => chunk.text.length > 0);
}

function splitDocChunks(text: string): MarkdownDocChunk[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  return splitMarkdownSections(normalized).flatMap(splitLargeMarkdownSection);
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
  const canonicalUrl = canonicalDocGitUrl(url);
  if (requestedCheckoutPath) return expandHome(requestedCheckoutPath);
  if (canonicalUrl === OFFICIAL_DOCS_GIT_URL) return frameworkDocsCheckoutPath(dataDir);
  const safeName = canonicalUrl.replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).pop()?.replace(/[^a-z0-9._-]+/gi, "-") || "git-docs";
  return path.join(path.dirname(frameworkDocsCheckoutPath(dataDir)), safeName);
}

export async function addGitDocSource(dataDir: string, url = OFFICIAL_DOCS_GIT_URL, checkoutPath?: string, name?: string): Promise<DocSource> {
  const canonicalUrl = canonicalDocGitUrl(url);
  await ensureSqliteStore(sqlitePath(dataDir));
  const now = new Date().toISOString();
  const checkoutRoot = await gitCheckoutRoot(dataDir, canonicalUrl, checkoutPath);
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
    `).get(canonicalUrl, checkoutRoot, checkoutRoot, nullable(name), now, now) as unknown as DocSourceRow;
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

async function docsFromSource(source: DocSource): Promise<ScannedDocResource[]> {
  const root = source.rootPath ?? source.checkoutPath;
  if (!root) return [];
  const files = await fg(["**/*.{md,txt}"], { cwd: root, onlyFiles: true, dot: false }).catch(() => [] as string[]);
  const resources: ScannedDocResource[] = [];
  for (const relativePath of files.sort()) {
    const fullPath = path.join(root, relativePath);
    const stat = await fs.stat(fullPath);
    const name = resourceName(source, relativePath);
    resources.push({
      uri: `bitrix-docs://${sourceUriPrefix(source)}/${encodeRelativeUri(relativePath)}`,
      name,
      description: `Bitrix Framework documentation: ${name}`,
      mimeType: mimeTypeFor(relativePath),
      path: fullPath,
      relativePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return resources;
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

export interface IndexDocResourcesOptions {
  includeOfficialDocs?: boolean;
  updateGitSources?: boolean;
  officialDocsUrl?: string;
  force?: boolean;
}

export async function countDocChunks(dataDir: string): Promise<number> {
  await ensureSqliteStore(sqlitePath(dataDir));
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM doc_chunks").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

interface EmbeddingDocChunkRow {
  chunk_id: number;
  uri: string;
  title: string | null;
  path: string | null;
  source_name: string | null;
  chunk_index: number;
  text: string;
  heading_path: string | null;
  section_anchor: string | null;
  source_uri: string | null;
  relative_path: string | null;
}

export async function prepareEmbeddingDocumentsFromSqlite(dataDir: string): Promise<EmbeddingsDocument[]> {
  await ensureSqliteStore(sqlitePath(dataDir));
  const db = openDatabase(sqlitePath(dataDir));
  try {
    const rows = db.prepare(`
      SELECT
        doc_chunks.id AS chunk_id,
        docs.uri,
        docs.title,
        docs.path,
        docs.source_name,
        doc_chunks.chunk_index,
        doc_chunks.text,
        doc_chunks.heading_path,
        doc_chunks.section_anchor,
        doc_chunks.source_uri,
        doc_chunks.relative_path
      FROM doc_chunks
      JOIN docs ON docs.id = doc_chunks.doc_id
      ORDER BY docs.uri, doc_chunks.chunk_index
    `).all() as unknown as EmbeddingDocChunkRow[];

    return rows.map((row) => ({
      id: `${row.uri}#chunk-${row.chunk_index}`,
      text: row.text,
      metadata: {
        chunkId: row.chunk_id,
        uri: row.uri,
        title: row.title ?? undefined,
        path: row.path ?? undefined,
        sourceName: row.source_name ?? undefined,
        chunkIndex: row.chunk_index,
        headingPath: row.heading_path ?? undefined,
        sectionAnchor: row.section_anchor ?? undefined,
        sourceUri: row.source_uri ?? row.uri,
        relativePath: row.relative_path ?? undefined
      }
    }));
  } finally {
    db.close();
  }
}

export async function indexDocResourcesToSqlite(dataDir: string, docsPaths: string[] = [], options: IndexDocResourcesOptions = {}): Promise<number> {
  if (options.includeOfficialDocs) {
    await addGitDocSource(dataDir, options.officialDocsUrl ?? OFFICIAL_DOCS_GIT_URL);
  }
  if (docsPaths.length > 0) {
    await addPathDocSources(dataDir, docsPaths);
  }
  if (options.updateGitSources ?? options.includeOfficialDocs) {
    await updateDocSources(dataDir);
  }
  const sources = await listDocSources(dataDir);
  for (const source of sources) {
    const resources = await docsFromSource(source);
    const currentUris: string[] = [];
    const existingByUri = new Map((await readExistingDocsBySource(sqlitePath(dataDir), source.id)).map((metadata) => [metadata.uri, metadata]));
    const changedChunks: DocIndexChunk[] = [];
    for (const resource of resources) {
      const existing = existingByUri.get(resource.uri);
      if (!options.force && existing && existing.size === resource.size && existing.mtimeMs === resource.mtimeMs) {
        currentUris.push(resource.uri);
        continue;
      }

      const contents = await fs.readFile(resource.path, "utf8");
      const title = titleFromText(contents, resource.name);
      const chunks = splitDocChunks(contents);
      if (chunks.length === 0) {
        continue;
      }
      currentUris.push(resource.uri);
      chunks.forEach((chunk, chunkIndex) => {
        changedChunks.push({
          uri: resource.uri,
          sourceId: source.id,
          sourceName: sourceDisplayName(source),
          title,
          path: resource.path,
          mimeType: resource.mimeType,
          size: resource.size,
          mtimeMs: resource.mtimeMs,
          chunkIndex,
          text: chunk.text,
          headingPath: chunk.headingPath,
          sectionAnchor: chunk.sectionAnchor,
          sourceUri: resource.uri,
          relativePath: resource.relativePath
        });
      });
    }
    await writeDocsToSqlite(sqlitePath(dataDir), changedChunks, { sourceId: source.id, currentUris });
  }
  return countDocChunks(dataDir);
}
