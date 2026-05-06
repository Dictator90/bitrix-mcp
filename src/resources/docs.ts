import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { sqlitePath } from "../config/paths.js";
import { writeDocsToSqlite, type DocIndexChunk } from "../indexer/sqliteStore.js";
import type { DocResource } from "../types.js";

const DOC_CHUNK_SIZE = 1800;
const DOC_CHUNK_OVERLAP = 200;

export async function listDocResources(docsDir: string): Promise<DocResource[]> {
  const root = path.resolve(docsDir);
  const files = await fg(["**/*.{md,txt}"], { cwd: root, onlyFiles: true, dot: false }).catch(() => [] as string[]);
  return files.sort().map((relativePath) => {
    const name = relativePath.replace(/\.(md|txt)$/i, "").replace(/[\\/]/g, " / ");
    return {
      uri: `bitrix-docs://${relativePath}`,
      name,
      description: `Bitrix Framework documentation: ${name}`,
      mimeType: relativePath.endsWith(".md") ? "text/markdown" : "text/plain",
      path: path.join(root, relativePath)
    };
  });
}

export async function readDocResource(docsDir: string, uri: string): Promise<{ contents: string; resource: DocResource }> {
  const resources = await listDocResources(docsDir);
  const resource = resources.find((entry) => entry.uri === uri);
  if (!resource) {
    throw new Error(`Unknown documentation resource: ${uri}`);
  }
  return { contents: await fs.readFile(resource.path, "utf8"), resource };
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

export async function indexDocResourcesToSqlite(docsDir: string, dataDir: string): Promise<number> {
  const resources = await listDocResources(docsDir);
  const chunks: DocIndexChunk[] = [];
  for (const resource of resources) {
    const contents = await fs.readFile(resource.path, "utf8");
    const title = titleFromText(contents, resource.name);
    splitDocChunks(contents).forEach((text, chunkIndex) => {
      chunks.push({
        uri: resource.uri,
        title,
        path: resource.path,
        mimeType: resource.mimeType,
        chunkIndex,
        text
      });
    });
  }
  await writeDocsToSqlite(sqlitePath(dataDir), chunks);
  return chunks.length;
}
