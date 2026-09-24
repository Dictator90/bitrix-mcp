import type { DatabaseSync } from "node:sqlite";
import { identifierTokenText, stemText } from "../../search/textTokens.js";

/**
 * FTS5 tables. They are contentless (the text lives in symbols/events/doc_chunks)
 * with `contentless_delete` so rows can still be deleted by rowid. Code tables
 * carry a `tokens` column with camelCase/namespace/snake_case parts
 * (`CIBlockElement` → `iblock`, `element`, …); the docs table carries `stems`,
 * the text with Russian words stemmed, and uses the porter stemmer for English.
 */
const CODE_FTS_OPTIONS = "content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='2 3'";
const DOCS_FTS_OPTIONS = "content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'";

export const FTS_TABLES_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name, tokens, type, module, class_name, fqn, signature, description, ${CODE_FTS_OPTIONS}
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    name, tokens, module, handler_class, handler_method, handler_function, signature, description, ${CODE_FTS_OPTIONS}
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title, path, heading, text, stems, ${DOCS_FTS_OPTIONS}
  );
`;

/** bm25() column weights, in column order: names and name parts count far more than signatures or prose. */
export const SYMBOLS_FTS_WEIGHTS = "10.0, 6.0, 0.5, 2.0, 4.0, 3.0, 1.0, 1.0";
export const EVENTS_FTS_WEIGHTS = "10.0, 6.0, 3.0, 4.0, 4.0, 4.0, 1.0, 1.0";
export const DOCS_FTS_WEIGHTS = "8.0, 2.0, 5.0, 1.0, 1.0";

export const INSERT_SYMBOL_FTS_SQL = "INSERT INTO symbols_fts (rowid, name, tokens, type, module, class_name, fqn, signature, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const INSERT_EVENT_FTS_SQL = "INSERT INTO events_fts (rowid, name, tokens, module, handler_class, handler_method, handler_function, signature, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const INSERT_DOC_FTS_SQL = "INSERT INTO docs_fts (rowid, title, path, heading, text, stems) VALUES (?, ?, ?, ?, ?, ?)";

type Text = string | null | undefined;

export function symbolFtsValues(symbol: { name: string; type: string; module?: Text; className?: Text; fullyQualifiedName?: Text; signature?: Text; description?: Text }): Array<string | null> {
  return [
    symbol.name,
    identifierTokenText(symbol.name, symbol.className, symbol.fullyQualifiedName),
    symbol.type,
    symbol.module ?? null,
    symbol.className ?? null,
    symbol.fullyQualifiedName ?? null,
    symbol.signature ?? null,
    symbol.description ?? null
  ];
}

export function eventFtsValues(event: { name: string; module?: Text; handlerClass?: Text; handlerMethod?: Text; handlerFunction?: Text; signature?: Text; description?: Text }): Array<string | null> {
  return [
    event.name,
    identifierTokenText(event.name, event.handlerClass, event.handlerMethod, event.handlerFunction),
    event.module ?? null,
    event.handlerClass ?? null,
    event.handlerMethod ?? null,
    event.handlerFunction ?? null,
    event.signature ?? null,
    event.description ?? null
  ];
}

export function docFtsValues(chunk: { title?: Text; path?: Text; headingPath?: Text; text: string }): Array<string | null> {
  return [
    chunk.title ?? null,
    chunk.path ?? null,
    chunk.headingPath ?? null,
    chunk.text,
    stemText([chunk.title, chunk.headingPath, chunk.text].filter(Boolean).join(" "))
  ];
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/**
 * Replaces FTS tables created by older versions (different columns, stored
 * content) and refills them from the base tables. Runs inside the migration
 * transaction.
 */
export function rebuildOutdatedFtsTables(db: DatabaseSync): void {
  const outdated = {
    symbols: !columns(db, "symbols_fts").includes("tokens"),
    events: !columns(db, "events_fts").includes("tokens"),
    docs: !columns(db, "docs_fts").includes("stems")
  };
  if (outdated.symbols) db.exec("DROP TABLE IF EXISTS symbols_fts;");
  if (outdated.events) db.exec("DROP TABLE IF EXISTS events_fts;");
  if (outdated.docs) db.exec("DROP TABLE IF EXISTS docs_fts;");
  db.exec(FTS_TABLES_DDL);

  if (outdated.symbols) {
    const insert = db.prepare(INSERT_SYMBOL_FTS_SQL);
    for (const row of db.prepare("SELECT id, name, type, module, class_name, fully_qualified_name, signature, description FROM symbols").iterate() as Iterable<Record<string, string | number | null>>) {
      insert.run(row.id, ...symbolFtsValues({ name: String(row.name), type: String(row.type), module: row.module as Text, className: row.class_name as Text, fullyQualifiedName: row.fully_qualified_name as Text, signature: row.signature as Text, description: row.description as Text }));
    }
  }
  if (outdated.events) {
    const insert = db.prepare(INSERT_EVENT_FTS_SQL);
    for (const row of db.prepare("SELECT id, name, module, handler_class, handler_method, handler_function, signature, description FROM events").iterate() as Iterable<Record<string, string | number | null>>) {
      insert.run(row.id, ...eventFtsValues({ name: String(row.name), module: row.module as Text, handlerClass: row.handler_class as Text, handlerMethod: row.handler_method as Text, handlerFunction: row.handler_function as Text, signature: row.signature as Text, description: row.description as Text }));
    }
  }
  if (outdated.docs) {
    const insert = db.prepare(INSERT_DOC_FTS_SQL);
    for (const row of db.prepare("SELECT c.id, d.title, d.path, c.heading_path, c.text FROM doc_chunks c JOIN docs d ON d.id = c.doc_id").iterate() as Iterable<Record<string, string | number | null>>) {
      insert.run(row.id, ...docFtsValues({ title: row.title as Text, path: row.path as Text, headingPath: row.heading_path as Text, text: String(row.text) }));
    }
  }
}
