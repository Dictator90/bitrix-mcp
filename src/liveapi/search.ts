import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { EventRecord, SearchResult, SymbolRecord } from "../types.js";

export interface LiveApiQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

export interface DocSearchResult {
  uri: string;
  title?: string;
  path?: string;
  chunkIndex: number;
  text: string;
}

interface SymbolRow {
  type: SymbolRecord["type"];
  language: string | null;
  name: string;
  module: string | null;
  class_name: string | null;
  file: string;
  line: number;
  signature: string | null;
  description: string | null;
  rank: number | null;
  exact_rank: number;
  prefix_rank: number;
  like_rank: number;
}

interface EventRow {
  module: string | null;
  name: string;
  handler_class: string | null;
  handler_method: string | null;
  handler_function: string | null;
  file: string;
  line: number;
  signature: string | null;
  description: string | null;
  rank: number | null;
  exact_rank: number;
  prefix_rank: number;
  like_rank: number;
}

interface DocRow {
  uri: string;
  title: string | null;
  path: string | null;
  chunk_index: number;
  text: string;
  rank: number | null;
  exact_rank: number;
  prefix_rank: number;
  like_rank: number;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile, { readOnly: true });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&").toLowerCase();
}

function ftsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((token) => `"${token.replace(/"/g, '""')}"*`) ?? [];
  return tokens.join(" ") || "__bitrix_mcp_no_match__";
}

function symbolScore(row: SymbolRow): number {
  if (row.exact_rank) return 1;
  if (row.prefix_rank) return 0.9;
  if (row.like_rank) return 0.8;
  return row.rank == null ? 0.65 : Math.max(0.4, Math.min(0.7, 0.7 - row.rank / 100));
}

function eventScore(row: EventRow): number {
  if (row.exact_rank) return 1;
  if (row.prefix_rank) return 0.9;
  if (row.like_rank) return 0.8;
  return row.rank == null ? 0.65 : Math.max(0.4, Math.min(0.7, 0.7 - row.rank / 100));
}

function docScore(row: DocRow): number {
  if (row.exact_rank) return 1;
  if (row.prefix_rank) return 0.9;
  if (row.like_rank) return 0.8;
  return row.rank == null ? 0.65 : Math.max(0.4, Math.min(0.7, 0.7 - row.rank / 100));
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    module: row.module ?? "",
    eventName: row.name,
    handlerClass: row.handler_class ?? undefined,
    handlerMethod: row.handler_method ?? undefined,
    handlerFunction: row.handler_function ?? undefined,
    file: row.file,
    line: row.line,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined
  };
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    type: row.type,
    language: row.language ?? undefined,
    name: row.name,
    module: row.module ?? undefined,
    className: row.class_name ?? undefined,
    file: row.file,
    line: row.line,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined
  };
}

export async function searchLiveApi(dbFile: string, query: LiveApiQuery): Promise<SearchResult<SymbolRecord>[] | undefined> {
  return searchSqliteLiveApi(dbFile, query);
}

export async function searchSqliteLiveApi(dbFile: string, query: LiveApiQuery): Promise<SearchResult<SymbolRecord>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }

  const normalizedQuery = query.query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const fts = ftsQuery(normalizedQuery);
  const exact = normalizedQuery.toLowerCase();
  const prefix = `${escapeLike(normalizedQuery)}%`;
  const like = `%${escapeLike(normalizedQuery)}%`;
  const limit = query.limit ?? 20;
  const filterParams: Array<string | number> = [];
  const filters: string[] = [];
  if (query.type) {
    filters.push("type = ?");
    filterParams.push(query.type);
  }
  if (query.module) {
    filters.push("module = ?");
    filterParams.push(query.module);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT
          s.*,
          CASE WHEN lower(s.name) = ? OR lower(coalesce(s.class_name, '')) = ? THEN 1 ELSE 0 END AS exact_rank,
          CASE WHEN lower(s.name) LIKE ? ESCAPE '\\' OR lower(coalesce(s.class_name, '')) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS prefix_rank,
          CASE WHEN lower(s.name) LIKE ? ESCAPE '\\'
             OR lower(coalesce(s.class_name, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(s.module, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(s.signature, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(s.description, '')) LIKE ? ESCAPE '\\'
          THEN 1 ELSE 0 END AS like_rank,
          NULL AS rank
        FROM symbols s
        WHERE exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1
        UNION
        SELECT
          s.*,
          0 AS exact_rank,
          0 AS prefix_rank,
          0 AS like_rank,
          bm25(symbols_fts) AS rank
        FROM symbols_fts
        JOIN symbols s ON s.id = symbols_fts.rowid
        WHERE symbols_fts MATCH ?
      )
      SELECT type, language, name, module, class_name, file, line, signature, description,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank
      FROM candidates
      ${where}
      GROUP BY type, language, name, module, class_name, file, line, signature, description
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, rank ASC, name ASC
      LIMIT ?
    `).all(exact, exact, prefix, prefix, like, like, like, like, like, fts, ...filterParams, limit) as unknown as SymbolRow[];

    return rows.map((row) => ({ score: symbolScore(row), item: rowToSymbol(row) }));
  } catch (error) {
    if ((error as Error).message.includes("fts5") || (error as Error).message.includes("MATCH")) {
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function searchSqliteEvents(dbFile: string, query: { query: string; module?: string; limit?: number }): Promise<SearchResult<EventRecord>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }

  const normalizedQuery = query.query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const fts = ftsQuery(normalizedQuery);
  const exact = normalizedQuery.toLowerCase();
  const prefix = `${escapeLike(normalizedQuery)}%`;
  const like = `%${escapeLike(normalizedQuery)}%`;
  const limit = query.limit ?? 20;
  const filterParams: Array<string | number> = [];
  const filters: string[] = [];
  if (query.module) {
    filters.push("module = ?");
    filterParams.push(query.module);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT
          e.*,
          CASE WHEN lower(e.name) = ? OR lower(coalesce(e.module, '') || ':' || e.name) = ? THEN 1 ELSE 0 END AS exact_rank,
          CASE WHEN lower(e.name) LIKE ? ESCAPE '\\' OR lower(coalesce(e.module, '') || ':' || e.name) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS prefix_rank,
          CASE WHEN lower(e.name) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.module, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.module, '') || ':' || e.name) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.handler_class, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.handler_method, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.handler_function, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.signature, '')) LIKE ? ESCAPE '\\'
             OR lower(coalesce(e.description, '')) LIKE ? ESCAPE '\\'
          THEN 1 ELSE 0 END AS like_rank,
          NULL AS rank
        FROM events e
        WHERE exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1
        UNION
        SELECT
          e.*,
          0 AS exact_rank,
          0 AS prefix_rank,
          0 AS like_rank,
          bm25(events_fts) AS rank
        FROM events_fts
        JOIN events e ON e.id = events_fts.rowid
        WHERE events_fts MATCH ?
      )
      SELECT module, name, handler_class, handler_method, handler_function, file, line, signature, description,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank
      FROM candidates
      ${where}
      GROUP BY module, name, handler_class, handler_method, handler_function, file, line, signature, description
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, rank ASC, name ASC
      LIMIT ?
    `).all(exact, exact, prefix, prefix, like, like, like, like, like, like, like, like, fts, ...filterParams, limit) as unknown as EventRow[];

    return rows.map((row) => ({ score: eventScore(row), item: rowToEvent(row) }));
  } catch (error) {
    if ((error as Error).message.includes("fts5") || (error as Error).message.includes("MATCH")) {
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function searchSqliteDocs(dbFile: string, query: { query: string; limit?: number }): Promise<SearchResult<DocSearchResult>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }

  const normalizedQuery = query.query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const fts = ftsQuery(normalizedQuery);
  const exact = normalizedQuery.toLowerCase();
  const prefix = `${escapeLike(normalizedQuery)}%`;
  const like = `%${escapeLike(normalizedQuery)}%`;
  const limit = query.limit ?? 5;
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT d.uri, d.title, d.path, c.chunk_index, c.text,
               CASE WHEN lower(coalesce(d.title, '')) = ? THEN 1 ELSE 0 END AS exact_rank,
               CASE WHEN lower(coalesce(d.title, '')) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS prefix_rank,
               CASE WHEN lower(coalesce(d.title, '')) LIKE ? ESCAPE '\\' OR lower(c.text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS like_rank,
               NULL AS rank
        FROM doc_chunks c
        JOIN docs d ON d.id = c.doc_id
        WHERE exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1
        UNION
        SELECT d.uri, d.title, d.path, c.chunk_index, c.text,
               0 AS exact_rank,
               0 AS prefix_rank,
               0 AS like_rank,
               bm25(docs_fts) AS rank
        FROM docs_fts
        JOIN doc_chunks c ON c.id = docs_fts.rowid
        JOIN docs d ON d.id = c.doc_id
        WHERE docs_fts MATCH ?
      )
      SELECT uri, title, path, chunk_index, text,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank
      FROM candidates
      GROUP BY uri, title, path, chunk_index, text
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, rank ASC, uri ASC, chunk_index ASC
      LIMIT ?
    `).all(exact, prefix, like, like, fts, limit) as unknown as DocRow[];

    return rows.map((row) => ({
      score: docScore(row),
      item: {
        uri: row.uri,
        title: row.title ?? undefined,
        path: row.path ?? undefined,
        chunkIndex: row.chunk_index,
        text: row.text
      }
    }));
  } catch (error) {
    if ((error as Error).message.includes("fts5") || (error as Error).message.includes("MATCH")) {
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}
