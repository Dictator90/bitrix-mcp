import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexFile, IndexKind, IndexManifest, IndexWarning, SymbolRecord } from "../types.js";

export interface SqliteStoreOptions {
  dbFile: string;
}

export interface SqliteSearchQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

export interface ExistingIndexFile {
  id: number;
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
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
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS doc_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        heading_path TEXT,
        section_anchor TEXT,
        source_uri TEXT,
        relative_path TEXT,
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
    if (!docColumns.includes("size")) {
      db.exec("ALTER TABLE docs ADD COLUMN size INTEGER NOT NULL DEFAULT 0;");
    }
    if (!docColumns.includes("mtime_ms")) {
      db.exec("ALTER TABLE docs ADD COLUMN mtime_ms REAL NOT NULL DEFAULT 0;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source_id);");

    const docChunkColumns = (db.prepare("PRAGMA table_info(doc_chunks)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["heading_path", "TEXT"],
      ["section_anchor", "TEXT"],
      ["source_uri", "TEXT"],
      ["relative_path", "TEXT"]
    ] as const) {
      if (!docChunkColumns.includes(column)) {
        db.exec(`ALTER TABLE doc_chunks ADD COLUMN ${column} ${definition};`);
      }
    }

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

export async function readExistingFilesByKind(dbFile: string, kind: IndexKind): Promise<ExistingIndexFile[]> {
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare("SELECT id, path, relative_path, size, mtime_ms FROM files WHERE kind = ?").all(kind) as Array<{ id: number; path: string; relative_path: string; size: number; mtime_ms: number }>;
    return rows.map((row) => ({ id: row.id, path: row.path, relativePath: row.relative_path, size: row.size, mtimeMs: row.mtime_ms }));
  } finally {
    db.close();
  }
}

export interface WriteIndexOptions {
  force?: boolean;
}

function warningMetaValue(warnings: IndexWarning[] | undefined): string {
  const diagnostics = warnings ?? [];
  return JSON.stringify({
    phpParseFallbackFiles: new Set(diagnostics.map((warning) => warning.file)).size,
    diagnostics
  });
}

function parseWarningMeta(value: string): { phpParseFallbackFiles: number; diagnostics: IndexWarning[] } {
  try {
    const parsed = JSON.parse(value) as { phpParseFallbackFiles?: unknown; diagnostics?: unknown };
    return {
      phpParseFallbackFiles: typeof parsed.phpParseFallbackFiles === "number" ? parsed.phpParseFallbackFiles : 0,
      diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics.filter((entry): entry is IndexWarning => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "php_parse_fallback" && typeof (entry as { file?: unknown }).file === "string" && typeof (entry as { message?: unknown }).message === "string") : []
    };
  } catch {
    return { phpParseFallbackFiles: 0, diagnostics: [] };
  }
}

export async function writeIndexToSqlite(dbFile: string, manifest: IndexManifest, options: WriteIndexOptions = {}): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const upsertFile = db.prepare(`
      INSERT INTO files (kind, root, path, relative_path, size, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, path) DO UPDATE SET
        root = excluded.root,
        relative_path = excluded.relative_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        language = excluded.language,
        indexed_at = excluded.indexed_at
      RETURNING id
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
    const existingFiles = db.prepare("SELECT id, path, relative_path, size, mtime_ms FROM files WHERE kind = ?").all(manifest.kind) as Array<{ id: number; path: string; relative_path: string; size: number; mtime_ms: number }>;
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const currentPaths = new Set(manifest.files.map((file) => file.path));
    const deleteSymbolsFtsForFile = db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)");
    const deleteEventsFtsForFile = db.prepare("DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE file_id = ?)");
    const deleteEventsForFile = db.prepare("DELETE FROM events WHERE file_id = ?");
    const deleteSymbolsForFile = db.prepare("DELETE FROM symbols WHERE file_id = ?");
    const deleteFileById = db.prepare("DELETE FROM files WHERE id = ?");

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (options.force) {
        db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE kind = ?)").run(manifest.kind);
        db.prepare("DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE kind = ?)").run(manifest.kind);
        db.prepare("DELETE FROM files WHERE kind = ?").run(manifest.kind);
        existingByPath.clear();
      } else {
        for (const file of existingFiles) {
          if (!currentPaths.has(file.path)) {
            deleteSymbolsFtsForFile.run(file.id);
            deleteEventsFtsForFile.run(file.id);
            deleteFileById.run(file.id);
            existingByPath.delete(file.path);
          }
        }
      }

      for (const file of manifest.files) {
        const existing = existingByPath.get(file.path);
        if (existing && existing.size === file.size && existing.mtime_ms === file.mtimeMs) {
          continue;
        }

        if (existing) {
          deleteSymbolsFtsForFile.run(existing.id);
          deleteEventsFtsForFile.run(existing.id);
          deleteEventsForFile.run(existing.id);
          deleteSymbolsForFile.run(existing.id);
        }

        const fileRow = upsertFile.get(file.kind, manifest.root, file.path, file.relativePath, file.size, file.mtimeMs, file.language, manifest.generatedAt) as { id: number };
        const fileId = fileRow.id;
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
      setMeta.run(`index:${manifest.kind}:warnings`, warningMetaValue(manifest.warnings), manifest.generatedAt);
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
    const warningRow = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(`index:${kind}:warnings`) as { value: string } | undefined;
    return {
      version: 1,
      generatedAt: fileRows[0].indexed_at,
      root: fileRows[0].root,
      kind,
      files,
      warnings: warningRow ? parseWarningMeta(warningRow.value).diagnostics : []
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
  docChunks: number;
  phpParseFallbackFiles: number;
  lastIndexedAt?: string;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function countPhpParseFallbackFiles(db: DatabaseSync): number {
  const rows = db.prepare("SELECT value FROM index_meta WHERE key LIKE 'index:%:warnings'").all() as Array<{ value: string }>;
  return rows.reduce((sum, row) => sum + parseWarningMeta(row.value).phpParseFallbackFiles, 0);
}

export async function readIndexWarnings(dbFile: string, kind?: IndexKind): Promise<IndexWarning[]> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = kind
      ? db.prepare("SELECT value FROM index_meta WHERE key = ?").all(`index:${kind}:warnings`) as Array<{ value: string }>
      : db.prepare("SELECT value FROM index_meta WHERE key LIKE 'index:%:warnings'").all() as Array<{ value: string }>;
    return rows.flatMap((row) => parseWarningMeta(row.value).diagnostics);
  } finally {
    db.close();
  }
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
      docChunks: countRows(db, "doc_chunks"),
      phpParseFallbackFiles: countPhpParseFallbackFiles(db),
      lastIndexedAt: lastIndexedRow.last_indexed_at ?? undefined
    };
  } finally {
    db.close();
  }
}

export interface ExistingDocIndexMetadata {
  uri: string;
  sourceId?: number;
  size: number;
  mtimeMs: number;
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
    const deleteFtsForDoc = db.prepare("DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = ?)");
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
            deleteDocById.run(doc.id);
          }
        }
      }

      const changedUris = new Set(chunks.map((chunk) => chunk.uri));
      for (const uri of changedUris) {
        const doc = selectChangedDoc.get(uri) as { id: number } | undefined;
        if (doc) {
          deleteFtsForDoc.run(doc.id);
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

export { searchSqliteLiveApi, searchSqliteDocs } from "../liveapi/search.js";
