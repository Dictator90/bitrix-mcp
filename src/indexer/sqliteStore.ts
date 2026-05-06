import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexFile, IndexKind, IndexManifest, SearchResult, SymbolRecord } from "../types.js";

export interface SqliteStoreOptions {
  dbFile: string;
}

export interface SqliteSearchQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

type SqliteValue = string | number | null;

interface FileRow {
  id: number;
  root: string;
  path: string;
  relative_path: string;
  size: number;
  mtime_ms: number;
  language: string;
  indexed_at: string;
}

interface SymbolRow {
  type: SymbolRecord["type"];
  name: string;
  module: string | null;
  class_name: string | null;
  file: string;
  line: number;
  signature: string | null;
  description: string | null;
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function scoreSymbol(symbol: SymbolRecord, query: string): number {
  const haystack = [symbol.name, symbol.className, symbol.module, symbol.signature, symbol.description].filter(Boolean).join(" ").toLowerCase();
  const needle = query.toLowerCase();
  if (symbol.name.toLowerCase() === needle) return 1;
  if (symbol.name.toLowerCase().includes(needle)) return 0.85;
  if (haystack.includes(needle)) return 0.6;
  return 0;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

export async function ensureSqliteStore(dbFile: string): Promise<void> {
  await fs.mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(kind, path)
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        module TEXT,
        class_name TEXT,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uri TEXT NOT NULL UNIQUE,
        title TEXT,
        path TEXT,
        mime_type TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS doc_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        UNIQUE(doc_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS doc_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        source_uri TEXT NOT NULL,
        source_title TEXT
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(type, module, name);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
    `);
  } finally {
    db.close();
  }
}

export async function writeIndexToSqlite(dbFile: string, manifest: IndexManifest): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insertFile = db.prepare(`
      INSERT INTO files (kind, root, path, relative_path, size, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (file_id, kind, root, type, name, module, class_name, file, line, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertEvent = db.prepare(`
      INSERT INTO events (symbol_id, file_id, kind, root, module, name, file, line, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const setMeta = db.prepare(`
      INSERT INTO index_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("DELETE FROM files WHERE kind = ?").run(manifest.kind);
      for (const file of manifest.files) {
        const result = insertFile.run(file.kind, manifest.root, file.path, file.relativePath, file.size, file.mtimeMs, file.language, manifest.generatedAt);
        const fileId = Number(result.lastInsertRowid);
        for (const symbol of file.symbols) {
          const symbolIdRow = insertSymbol.get(
            fileId,
            file.kind,
            manifest.root,
            symbol.type,
            symbol.name,
            nullable(symbol.module),
            nullable(symbol.className),
            symbol.file,
            symbol.line,
            nullable(symbol.signature),
            nullable(symbol.description)
          ) as { id: number };
          if (symbol.type === "event") {
            insertEvent.run(
              symbolIdRow.id,
              fileId,
              file.kind,
              manifest.root,
              nullable(symbol.module),
              symbol.name,
              symbol.file,
              symbol.line,
              nullable(symbol.signature),
              nullable(symbol.description)
            );
          }
        }
      }
      setMeta.run(`index:${manifest.kind}`, JSON.stringify({ version: manifest.version, generatedAt: manifest.generatedAt, root: manifest.root, kind: manifest.kind, files: manifest.files.length }), manifest.generatedAt);
      setMeta.run("schema_version", "1", manifest.generatedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function readIndexFromSqlite(dbFile: string, kind: IndexKind): Promise<IndexManifest | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const fileRows = db.prepare("SELECT id, root, path, relative_path, size, mtime_ms, language, indexed_at FROM files WHERE kind = ? ORDER BY relative_path").all(kind) as unknown as FileRow[];
    if (fileRows.length === 0) {
      return undefined;
    }
    const symbolSelect = db.prepare("SELECT type, name, module, class_name, file, line, signature, description FROM symbols WHERE file_id = ? ORDER BY id");
    const files: IndexFile[] = fileRows.map((file) => ({
      path: file.path,
      relativePath: file.relative_path,
      kind,
      size: file.size,
      mtimeMs: file.mtime_ms,
      language: file.language,
      symbols: (symbolSelect.all(file.id) as unknown as SymbolRow[]).map(rowToSymbol)
    }));
    return {
      version: 1,
      generatedAt: fileRows[0].indexed_at,
      root: fileRows[0].root,
      kind,
      files
    };
  } finally {
    db.close();
  }
}

export async function searchSqliteLiveApi(dbFile: string, query: SqliteSearchQuery): Promise<SearchResult<SymbolRecord>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const clauses = ["(lower(name) LIKE ? OR lower(coalesce(class_name, '')) LIKE ? OR lower(coalesce(module, '')) LIKE ? OR lower(coalesce(signature, '')) LIKE ? OR lower(coalesce(description, '')) LIKE ?)"];
    const needle = `%${query.query.toLowerCase()}%`;
    const params: SqliteValue[] = [needle, needle, needle, needle, needle];
    if (query.type) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.module) {
      clauses.push("module = ?");
      params.push(query.module);
    }

    const rows = db.prepare(`
      SELECT type, name, module, class_name, file, line, signature, description
      FROM symbols
      WHERE ${clauses.join(" AND ")}
      ORDER BY name
      LIMIT ?
    `).all(...params, Math.max(query.limit ?? 20, 100)) as unknown as SymbolRow[];

    return rows
      .map(rowToSymbol)
      .map((symbol) => ({ score: scoreSymbol(symbol, query.query), item: symbol }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
      .slice(0, query.limit ?? 20);
  } finally {
    db.close();
  }
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    type: row.type,
    name: row.name,
    module: row.module ?? undefined,
    className: row.class_name ?? undefined,
    file: row.file,
    line: row.line,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined
  };
}
