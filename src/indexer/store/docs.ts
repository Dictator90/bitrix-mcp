import fs from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "../database.js";
import { nullable } from "./rows.js";
import { ensureSqliteStore } from "./schema.js";

export interface ExistingDocIndexMetadata {
  uri: string;
  sourceId?: number;
  size: number;
  mtimeMs: number;
}

export interface DocSymbolRef {
  symbol: string;
  docUri: string;
  docPath?: string;
  title?: string;
  chunkIndex: number;
  excerpt?: string;
}

export interface DocIndexChunk {
  uri: string;
  sourceId?: number;
  sourceName?: string;
  title?: string;
  path?: string;
  mimeType?: string;
  size: number;
  mtimeMs: number;
  chunkIndex: number;
  text: string;
  headingPath?: string;
  sectionAnchor?: string;
  sourceUri?: string;
  relativePath?: string;
  symbolRefs?: string[];
}

export interface WriteDocsOptions {
  sourceId?: number;
  currentUris?: Iterable<string>;
}

export async function readExistingDocsBySource(dbFile: string, sourceId: number): Promise<ExistingDocIndexMetadata[]> {
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare("SELECT uri, source_id, size, mtime_ms FROM docs WHERE source_id = ?").all(sourceId) as Array<{ uri: string; source_id: number | null; size: number; mtime_ms: number }>;
    return rows.map((row) => ({ uri: row.uri, sourceId: row.source_id ?? undefined, size: row.size, mtimeMs: row.mtime_ms }));
  } finally {
    db.close();
  }
}

export async function writeDocsToSqlite(dbFile: string, chunks: DocIndexChunk[], options: WriteDocsOptions = {}, indexedAt = new Date().toISOString()): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insertDoc = db.prepare(`
      INSERT INTO docs (source_id, source_name, uri, title, path, mime_type, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        source_id = excluded.source_id,
        source_name = excluded.source_name,
        title = excluded.title,
        path = excluded.path,
        mime_type = excluded.mime_type,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
      RETURNING id
    `);
    const insertChunk = db.prepare(`
      INSERT INTO doc_chunks (doc_id, chunk_index, text, heading_path, section_anchor, source_uri, relative_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, chunk_index) DO UPDATE SET
        text = excluded.text,
        heading_path = excluded.heading_path,
        section_anchor = excluded.section_anchor,
        source_uri = excluded.source_uri,
        relative_path = excluded.relative_path
      RETURNING id
    `);
    const insertFts = db.prepare("INSERT INTO docs_fts (rowid, uri, title, path, text) VALUES (?, ?, ?, ?, ?)");
    const insertSymbolRef = db.prepare(`
      INSERT INTO doc_symbol_refs (symbol, doc_uri, doc_path, title, chunk_index, excerpt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, doc_uri, chunk_index) DO UPDATE SET
        doc_path = excluded.doc_path,
        title = excluded.title,
        excerpt = excluded.excerpt
    `);
    const deleteFtsForDoc = db.prepare("DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = ?)");
    const deleteSymbolRefsForDocUri = db.prepare("DELETE FROM doc_symbol_refs WHERE doc_uri = ?");
    const deleteChunksForDoc = db.prepare("DELETE FROM doc_chunks WHERE doc_id = ?");
    const deleteDocById = db.prepare("DELETE FROM docs WHERE id = ?");
    const selectChangedDoc = db.prepare("SELECT id FROM docs WHERE uri = ?");
    const setMeta = db.prepare(`
      INSERT INTO index_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (options.sourceId !== undefined && options.currentUris) {
        const currentUris = new Set(options.currentUris);
        const existingDocs = db.prepare("SELECT id, uri FROM docs WHERE source_id = ?").all(options.sourceId) as Array<{ id: number; uri: string }>;
        for (const doc of existingDocs) {
          if (!currentUris.has(doc.uri)) {
            deleteFtsForDoc.run(doc.id);
            deleteSymbolRefsForDocUri.run(doc.uri);
            deleteDocById.run(doc.id);
          }
        }
      }

      const changedUris = new Set(chunks.map((chunk) => chunk.uri));
      for (const uri of changedUris) {
        const doc = selectChangedDoc.get(uri) as { id: number } | undefined;
        if (doc) {
          deleteFtsForDoc.run(doc.id);
          deleteSymbolRefsForDocUri.run(uri);
          deleteChunksForDoc.run(doc.id);
        }
      }

      for (const chunk of chunks) {
        const doc = insertDoc.get(chunk.sourceId ?? null, nullable(chunk.sourceName), chunk.uri, nullable(chunk.title), nullable(chunk.path), nullable(chunk.mimeType), chunk.size, chunk.mtimeMs, indexedAt) as { id: number };
        const row = insertChunk.get(
          doc.id,
          chunk.chunkIndex,
          chunk.text,
          nullable(chunk.headingPath),
          nullable(chunk.sectionAnchor),
          nullable(chunk.sourceUri),
          nullable(chunk.relativePath)
        ) as { id: number };
        insertFts.run(row.id, chunk.uri, nullable(chunk.title), nullable(chunk.path), chunk.text);
        for (const symbol of chunk.symbolRefs ?? []) {
          insertSymbolRef.run(symbol, chunk.uri, nullable(chunk.path), nullable(chunk.title), chunk.chunkIndex, excerptForSymbolRef(chunk.text, symbol));
        }
      }
      const totalChunks = (db.prepare("SELECT COUNT(*) AS count FROM doc_chunks").get() as { count: number }).count;
      setMeta.run("index:docs", JSON.stringify({ generatedAt: indexedAt, chunks: totalChunks }), indexedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

function excerptForSymbolRef(text: string, symbol: string, maxChars = 500): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(symbol.toLowerCase());
  if (index < 0 || normalized.length <= maxChars) {
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
  }
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(normalized.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${end < normalized.length ? "…" : ""}`;
}

export async function searchDocSymbolRefs(dbFile: string, symbol: string, limit = 20): Promise<DocSymbolRef[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const normalizedSymbol = symbol.trim();
  if (!normalizedSymbol) return [];
  const db = openDatabase(dbFile);
  try {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = db.prepare(`
      SELECT symbol, doc_uri, doc_path, title, chunk_index, excerpt
      FROM doc_symbol_refs
      WHERE lower(symbol) = lower(?)
      ORDER BY title IS NULL, title ASC, doc_uri ASC, chunk_index ASC
      LIMIT ?
    `).all(normalizedSymbol, boundedLimit) as Array<{ symbol: string; doc_uri: string; doc_path: string | null; title: string | null; chunk_index: number | null; excerpt: string | null }>;
    return rows.map((row) => ({
      symbol: row.symbol,
      docUri: row.doc_uri,
      docPath: row.doc_path ?? undefined,
      title: row.title ?? undefined,
      chunkIndex: row.chunk_index ?? 0,
      excerpt: row.excerpt ?? undefined
    }));
  } finally {
    db.close();
  }
}
