import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexFile, IndexKind, IndexManifest, SymbolRecord } from "../types.js";

export interface SqliteStoreOptions {
  dbFile: string;
}

export interface SqliteSearchQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

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
  language: string | null;
  name: string;
  module: string | null;
  class_name: string | null;
  handler_class?: string | null;
  handler_method?: string | null;
  handler_function?: string | null;
  event_name?: string | null;
  file: string;
  line: number;
  signature: string | null;
  description: string | null;
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    type: row.type,
    language: row.language ?? undefined,
    name: row.name,
    module: row.module ?? undefined,
    className: row.class_name ?? undefined,
    handlerClass: row.handler_class ?? undefined,
    handlerMethod: row.handler_method ?? undefined,
    handlerFunction: row.handler_function ?? undefined,
    eventName: row.event_name ?? undefined,
    file: row.file,
    line: row.line,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined
  };
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
        language TEXT,
        name TEXT NOT NULL,
        module TEXT,
        class_name TEXT,
        handler_class TEXT,
        handler_method TEXT,
        handler_function TEXT,
        event_name TEXT,
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
        handler_class TEXT,
        handler_method TEXT,
        handler_function TEXT,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER REFERENCES doc_sources(id) ON DELETE SET NULL,
        uri TEXT NOT NULL UNIQUE,
        title TEXT,
        path TEXT,
        mime_type TEXT,
        source_name TEXT,
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
        type TEXT NOT NULL CHECK(type IN ('git', 'path')),
        uri TEXT NOT NULL,
        root_path TEXT,
        checkout_path TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(type, uri)
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name, type, module, class_name, signature, description
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        name, module, handler_class, handler_method, handler_function, signature, description
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        uri, title, path, text
      );

      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(type, module, name);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);

      INSERT OR IGNORE INTO symbols_fts (rowid, name, type, module, class_name, signature, description)
      SELECT id, name, type, module, class_name, signature, description FROM symbols;


      INSERT OR IGNORE INTO docs_fts (rowid, uri, title, path, text)
      SELECT doc_chunks.id, docs.uri, docs.title, docs.path, doc_chunks.text
      FROM doc_chunks
      JOIN docs ON docs.id = doc_chunks.doc_id;
    `);

    const docSourceColumns = (db.prepare("PRAGMA table_info(doc_sources)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!docSourceColumns.includes("type")) {
      db.exec(`
        DROP TABLE IF EXISTS doc_sources;
        CREATE TABLE doc_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('git', 'path')),
          uri TEXT NOT NULL,
          root_path TEXT,
          checkout_path TEXT,
          name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(type, uri)
        );
      `);
    }

    const docColumns = (db.prepare("PRAGMA table_info(docs)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!docColumns.includes("source_id")) {
      db.exec("ALTER TABLE docs ADD COLUMN source_id INTEGER REFERENCES doc_sources(id) ON DELETE SET NULL;");
    }
    if (!docColumns.includes("source_name")) {
      db.exec("ALTER TABLE docs ADD COLUMN source_name TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source_id);");
    const symbolColumns = (db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["handler_class", "TEXT"],
      ["handler_method", "TEXT"],
      ["handler_function", "TEXT"],
      ["event_name", "TEXT"],
      ["language", "TEXT"]
    ] as const) {
      if (!symbolColumns.includes(column)) {
        db.exec(`ALTER TABLE symbols ADD COLUMN ${column} ${definition};`);
      }
    }

    const eventColumns = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["handler_class", "TEXT"],
      ["handler_method", "TEXT"],
      ["handler_function", "TEXT"]
    ] as const) {
      if (!eventColumns.includes(column)) {
        db.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition};`);
      }
    }

    const eventFtsColumns = (db.prepare("PRAGMA table_info(events_fts)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!eventFtsColumns.includes("handler_class")) {
      db.exec(`
        DROP TABLE IF EXISTS events_fts;
        CREATE VIRTUAL TABLE events_fts USING fts5(
          name, module, handler_class, handler_method, handler_function, signature, description
        );
      `);
    }
    db.exec(`
      INSERT OR IGNORE INTO events_fts (rowid, name, module, handler_class, handler_method, handler_function, signature, description)
      SELECT id, name, module, handler_class, handler_method, handler_function, signature, description FROM events;
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
      INSERT INTO symbols (file_id, kind, root, type, language, name, module, class_name, handler_class, handler_method, handler_function, event_name, file, line, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertEvent = db.prepare(`
      INSERT INTO events (symbol_id, file_id, kind, root, module, name, handler_class, handler_method, handler_function, file, line, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSymbolFts = db.prepare(`
      INSERT INTO symbols_fts (rowid, name, type, module, class_name, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEventFts = db.prepare(`
      INSERT INTO events_fts (rowid, name, module, handler_class, handler_method, handler_function, signature, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const setMeta = db.prepare(`
      INSERT INTO index_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE kind = ?)").run(manifest.kind);
      db.prepare("DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE kind = ?)").run(manifest.kind);
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
            nullable(symbol.language ?? file.language),
            symbol.name,
            nullable(symbol.module),
            nullable(symbol.className),
            nullable(symbol.handlerClass),
            nullable(symbol.handlerMethod),
            nullable(symbol.handlerFunction),
            nullable(symbol.eventName),
            symbol.file,
            symbol.line,
            nullable(symbol.signature),
            nullable(symbol.description)
          ) as { id: number };
          insertSymbolFts.run(
            symbolIdRow.id,
            symbol.name,
            symbol.type,
            nullable(symbol.module),
            nullable(symbol.className),
            nullable(symbol.signature),
            nullable(symbol.description)
          );
          if (symbol.type === "event") {
            const eventResult = insertEvent.run(
              symbolIdRow.id,
              fileId,
              file.kind,
              manifest.root,
              nullable(symbol.module),
              symbol.eventName ?? symbol.name,
              nullable(symbol.handlerClass),
              nullable(symbol.handlerMethod),
              nullable(symbol.handlerFunction),
              symbol.file,
              symbol.line,
              nullable(symbol.signature),
              nullable(symbol.description)
            );
            insertEventFts.run(
              Number(eventResult.lastInsertRowid),
              symbol.eventName ?? symbol.name,
              nullable(symbol.module),
              nullable(symbol.handlerClass),
              nullable(symbol.handlerMethod),
              nullable(symbol.handlerFunction),
              nullable(symbol.signature),
              nullable(symbol.description)
            );
          }
        }
      }
      setMeta.run(`index:${manifest.kind}`, JSON.stringify({ version: manifest.version, generatedAt: manifest.generatedAt, root: manifest.root, kind: manifest.kind, files: manifest.files.length }), manifest.generatedAt);
      setMeta.run("schema_version", "3", manifest.generatedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function hasIndexMetadata(dbFile: string, kind: IndexKind): Promise<boolean> {
  try {
    await fs.access(dbFile);
  } catch {
    return false;
  }

  const db = openDatabase(dbFile);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'index_meta'").get();
    if (!table) {
      return false;
    }
    const row = db.prepare("SELECT 1 FROM index_meta WHERE key = ? LIMIT 1").get(`index:${kind}`);
    return Boolean(row);
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
    const symbolSelect = db.prepare("SELECT type, language, name, module, class_name, handler_class, handler_method, handler_function, event_name, file, line, signature, description FROM symbols WHERE file_id = ? ORDER BY id");
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


export interface IndexStatus {
  dbFile: string;
  files: number;
  symbols: number;
  events: number;
  documents: number;
  lastIndexedAt?: string;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export async function getIndexStatus(dbFile: string): Promise<IndexStatus> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const lastIndexedRow = db.prepare("SELECT MAX(updated_at) AS last_indexed_at FROM index_meta WHERE key LIKE 'index:%'").get() as { last_indexed_at: string | null };
    return {
      dbFile,
      files: countRows(db, "files"),
      symbols: countRows(db, "symbols"),
      events: countRows(db, "events"),
      documents: countRows(db, "docs"),
      lastIndexedAt: lastIndexedRow.last_indexed_at ?? undefined
    };
  } finally {
    db.close();
  }
}

export interface DocIndexChunk {
  uri: string;
  sourceId?: number;
  sourceName?: string;
  title?: string;
  path?: string;
  mimeType?: string;
  chunkIndex: number;
  text: string;
}

export async function writeDocsToSqlite(dbFile: string, chunks: DocIndexChunk[], indexedAt = new Date().toISOString()): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insertDoc = db.prepare(`
      INSERT INTO docs (source_id, source_name, uri, title, path, mime_type, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        source_id = excluded.source_id,
        source_name = excluded.source_name,
        title = excluded.title,
        path = excluded.path,
        mime_type = excluded.mime_type,
        indexed_at = excluded.indexed_at
      RETURNING id
    `);
    const insertChunk = db.prepare(`
      INSERT INTO doc_chunks (doc_id, chunk_index, text)
      VALUES (?, ?, ?)
      ON CONFLICT(doc_id, chunk_index) DO UPDATE SET text = excluded.text
      RETURNING id
    `);
    const insertFts = db.prepare("INSERT INTO docs_fts (rowid, uri, title, path, text) VALUES (?, ?, ?, ?, ?)");
    const setMeta = db.prepare(`
      INSERT INTO index_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("DELETE FROM docs_fts;");
      db.exec("DELETE FROM docs;");
      for (const chunk of chunks) {
        const doc = insertDoc.get(chunk.sourceId ?? null, nullable(chunk.sourceName), chunk.uri, nullable(chunk.title), nullable(chunk.path), nullable(chunk.mimeType), indexedAt) as { id: number };
        const row = insertChunk.get(doc.id, chunk.chunkIndex, chunk.text) as { id: number };
        insertFts.run(row.id, chunk.uri, nullable(chunk.title), nullable(chunk.path), chunk.text);
      }
      setMeta.run("index:docs", JSON.stringify({ generatedAt: indexedAt, chunks: chunks.length }), indexedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export { searchSqliteLiveApi, searchSqliteDocs } from "../liveapi/search.js";
