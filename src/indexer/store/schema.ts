import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../database.js";

export const SCHEMA_VERSION = 4;

/**
 * Version of the parser output. Stored per file; bump it whenever parsing
 * changes what is extracted, so unchanged files are re-parsed on the next
 * index run instead of keeping stale symbols until `--force`.
 */
export const PARSER_VERSION = 3;

const migratedDatabases = new Set<string>();

async function databaseIdentity(dbFile: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(dbFile);
    return `${path.resolve(dbFile)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Creates or migrates the index schema. The DDL runs at most once per database
 * per process, and only when `PRAGMA user_version` is older than
 * {@link SCHEMA_VERSION}; otherwise this is a single cheap read, so search
 * tools never take a write lock (they previously re-ran DDL and a full FTS
 * resync on every call and failed with "database is locked" during indexing).
 */
export async function ensureSqliteStore(dbFile: string): Promise<void> {
  const identity = await databaseIdentity(dbFile);
  if (identity && migratedDatabases.has(identity)) return;

  await fs.mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  try {
    if (schemaVersion(db) < SCHEMA_VERSION) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("BEGIN IMMEDIATE;");
      try {
        // Another process may have migrated while we waited for the lock.
        if (schemaVersion(db) < SCHEMA_VERSION) {
          migrateSchema(db);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    }
  } finally {
    db.close();
  }
  const migratedIdentity = await databaseIdentity(dbFile);
  if (migratedIdentity) migratedDatabases.add(migratedIdentity);
}

function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function migrateSchema(db: DatabaseSync): void {
  {
    db.exec(`
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
        parser_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(kind, path)
      );

      CREATE TABLE IF NOT EXISTS call_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        class_name TEXT,
        module TEXT,
        line INTEGER NOT NULL,
        signature TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_call_sites_name ON call_sites(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_call_sites_file_id ON call_sites(file_id);

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        type TEXT NOT NULL,
        language TEXT,
        name TEXT NOT NULL,
        module TEXT,
        fully_qualified_name TEXT,
        namespace TEXT,
        class_name TEXT,
        visibility TEXT,
        is_static INTEGER,
        is_abstract INTEGER,
        is_final INTEGER,
        return_type TEXT,
        extends_name TEXT,
        implements_json TEXT,
        traits_json TEXT,
        parameters_json TEXT,
        handler_class TEXT,
        handler_method TEXT,
        handler_function TEXT,
        event_name TEXT,
        agent_action TEXT,
        api TEXT,
        site_id TEXT,
        periodic TEXT,
        interval INTEGER,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        line_end INTEGER,
        signature TEXT,
        description TEXT,
        component_template TEXT,
        params_json TEXT
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

      CREATE TABLE IF NOT EXISTS module_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT NOT NULL,
        call TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hlblock_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        hlblock_id TEXT NOT NULL,
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT
      );

      CREATE TABLE IF NOT EXISTS option_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT NOT NULL,
        name TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('get', 'set')),
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT
      );

      CREATE TABLE IF NOT EXISTS orm_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        class_name TEXT NOT NULL,
        fully_qualified_name TEXT NOT NULL,
        namespace TEXT,
        parent_class TEXT,
        module TEXT,
        table_name TEXT,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        references_json TEXT NOT NULL,
        signature TEXT
      );

      CREATE TABLE IF NOT EXISTS orm_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        entity TEXT NOT NULL,
        method TEXT NOT NULL,
        usage_kind TEXT NOT NULL,
        module TEXT,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT
      );

      CREATE TABLE IF NOT EXISTS iblock_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        iblock_id TEXT NOT NULL,
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT,
        component TEXT
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

      CREATE TABLE IF NOT EXISTS doc_symbol_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        doc_uri TEXT NOT NULL,
        doc_path TEXT,
        title TEXT,
        chunk_index INTEGER,
        excerpt TEXT
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS autoload_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        namespace_prefix TEXT,
        paths_json TEXT NOT NULL,
        file TEXT,
        package_name TEXT,
        version_constraint TEXT,
        source_file TEXT NOT NULL,
        root TEXT NOT NULL,
        dev INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS bitrix_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_name TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        module TEXT,
        kind TEXT,
        signature TEXT,
        metadata_json TEXT
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

      CREATE INDEX IF NOT EXISTS idx_doc_symbol_refs_symbol ON doc_symbol_refs(symbol);
      CREATE INDEX IF NOT EXISTS idx_doc_symbol_refs_doc_uri ON doc_symbol_refs(doc_uri);
      CREATE INDEX IF NOT EXISTS idx_doc_symbol_refs_doc_path ON doc_symbol_refs(doc_path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_symbol_refs_unique ON doc_symbol_refs(symbol, doc_uri, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_module_usages_file_id ON module_usages(file_id);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_file_id ON orm_entities(file_id);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_file_id ON orm_usages(file_id);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_file_id ON iblock_usages(file_id);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_file_id ON hlblock_usages(file_id);
      CREATE INDEX IF NOT EXISTS idx_option_usages_file_id ON option_usages(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(type, module, name);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
      CREATE INDEX IF NOT EXISTS idx_module_usages_module ON module_usages(module);
      CREATE INDEX IF NOT EXISTS idx_module_usages_call ON module_usages(call);
      CREATE INDEX IF NOT EXISTS idx_module_usages_kind ON module_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_module_usages_file ON module_usages(file);
      CREATE INDEX IF NOT EXISTS idx_module_usages_relative_file ON module_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_class ON orm_entities(class_name);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_table ON orm_entities(table_name);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_kind ON orm_entities(kind);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_file ON orm_entities(file);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_entity ON orm_usages(entity);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_method ON orm_usages(method);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_kind ON orm_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_file ON orm_usages(file);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_iblock_id ON iblock_usages(iblock_id);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_api ON iblock_usages(api);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_kind ON iblock_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_file ON iblock_usages(file);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_relative_file ON iblock_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_hlblock_id ON hlblock_usages(hlblock_id);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_api ON hlblock_usages(api);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_kind ON hlblock_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_file ON hlblock_usages(file);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_relative_file ON hlblock_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_option_usages_module ON option_usages(module);
      CREATE INDEX IF NOT EXISTS idx_option_usages_name ON option_usages(name);
      CREATE INDEX IF NOT EXISTS idx_option_usages_operation ON option_usages(operation);
      CREATE INDEX IF NOT EXISTS idx_option_usages_api ON option_usages(api);
      CREATE INDEX IF NOT EXISTS idx_option_usages_kind ON option_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_option_usages_file ON option_usages(file);
      CREATE INDEX IF NOT EXISTS idx_option_usages_relative_file ON option_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_autoload_records_type ON autoload_records(type);
      CREATE INDEX IF NOT EXISTS idx_autoload_records_namespace ON autoload_records(namespace_prefix);
      CREATE INDEX IF NOT EXISTS idx_autoload_records_package ON autoload_records(package_name);
      CREATE INDEX IF NOT EXISTS idx_autoload_records_file ON autoload_records(file);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_relation_type ON bitrix_relations(relation_type);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_source ON bitrix_relations(source_type, source_name);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_target ON bitrix_relations(target_type, target_name);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_file ON bitrix_relations(file);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_kind ON bitrix_relations(kind);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_module ON bitrix_relations(module);

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
      ["fully_qualified_name", "TEXT"],
      ["namespace", "TEXT"],
      ["visibility", "TEXT"],
      ["is_static", "INTEGER"],
      ["is_abstract", "INTEGER"],
      ["is_final", "INTEGER"],
      ["return_type", "TEXT"],
      ["extends_name", "TEXT"],
      ["implements_json", "TEXT"],
      ["traits_json", "TEXT"],
      ["parameters_json", "TEXT"],
      ["handler_class", "TEXT"],
      ["handler_method", "TEXT"],
      ["handler_function", "TEXT"],
      ["event_name", "TEXT"],
      ["agent_action", "TEXT"],
      ["api", "TEXT"],
      ["site_id", "TEXT"],
      ["periodic", "TEXT"],
      ["interval", "INTEGER"],
      ["language", "TEXT"],
      ["component_template", "TEXT"],
      ["params_json", "TEXT"],
      ["line_end", "INTEGER"]
    ] as const) {
      if (!symbolColumns.includes(column)) {
        db.exec(`ALTER TABLE symbols ADD COLUMN ${column} ${definition};`);
      }
    }

    const fileColumns = (db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!fileColumns.includes("parser_version")) {
      // Existing rows get version 0, so every file is re-parsed once by the current parser.
      db.exec("ALTER TABLE files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0;");
    }
    // Call sites used to be stored as symbols (with full-statement signatures), bloating
    // symbols/symbols_fts and flooding search results; they now live in call_sites.
    db.exec(`
      DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE type IN ('static_call', 'method_call'));
      DELETE FROM symbols WHERE type IN ('static_call', 'method_call');
    `);

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
  }
}
