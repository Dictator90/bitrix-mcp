import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { EventRecord, IndexKind, SearchResult, SymbolRecord } from "../types.js";

export interface LiveApiQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  kind?: IndexKind | IndexKind[];
  preferLocal?: boolean;
  limit?: number;
}

export interface LiveApiEventQuery {
  query: string;
  module?: string;
  kind?: IndexKind | IndexKind[];
  preferLocal?: boolean;
  limit?: number;
}

export interface DocSearchResult {
  uri: string;
  title?: string;
  path?: string;
  headingPath?: string;
  sectionAnchor?: string;
  sourceUri?: string;
  relativePath?: string;
  chunkIndex: number;
  text: string;
}

interface SymbolRow {
  kind: IndexKind;
  type: SymbolRecord["type"];
  language: string | null;
  name: string;
  module: string | null;
  class_name: string | null;
  file: string;
  relative_file?: string | null;
  line: number;
  line_end?: number | null;
  signature: string | null;
  description: string | null;
  rank: number | null;
  exact_rank: number;
  prefix_rank: number;
  like_rank: number;
  local_rank: number;
}

interface EventRow {
  kind: IndexKind;
  module: string | null;
  name: string;
  handler_class: string | null;
  handler_method: string | null;
  handler_function: string | null;
  file: string;
  relative_file?: string | null;
  line: number;
  signature: string | null;
  description: string | null;
  rank: number | null;
  exact_rank: number;
  prefix_rank: number;
  like_rank: number;
  local_rank: number;
}

interface DocRow {
  uri: string;
  title: string | null;
  path: string | null;
  heading_path: string | null;
  section_anchor: string | null;
  source_uri: string | null;
  relative_path: string | null;
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

function candidateLimit(limit: number): number {
  return Math.max(100, Math.min(1_000, limit * 25));
}

function kindValues(kind: IndexKind | IndexKind[] | undefined): IndexKind[] {
  if (!kind) return [];
  return Array.isArray(kind) ? kind : [kind];
}

function localBoostExpression(alias: string, preferLocal: boolean | undefined): string {
  if (preferLocal === false) return "0";
  return `CASE WHEN ${alias}.kind IN ('project', 'template') THEN 1 ELSE 0 END`;
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
    kind: row.kind,
    module: row.module ?? "",
    eventName: row.name,
    handlerClass: row.handler_class ?? undefined,
    handlerMethod: row.handler_method ?? undefined,
    handlerFunction: row.handler_function ?? undefined,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined
  };
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    kind: row.kind,
    type: row.type,
    language: row.language ?? undefined,
    name: row.name,
    module: row.module ?? undefined,
    className: row.class_name ?? undefined,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    lineEnd: row.line_end ?? undefined,
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
  const maxCandidates = candidateLimit(limit);
  const branchFilters: string[] = [];
  const filterParams: Array<string | number> = [];
  if (query.type) {
    branchFilters.push("s.type = ?");
    filterParams.push(query.type);
  }
  if (query.module) {
    branchFilters.push("s.module = ?");
    filterParams.push(query.module);
  }
  const kinds = kindValues(query.kind);
  if (kinds.length) {
    branchFilters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
    filterParams.push(...kinds);
  }
  const branchWhere = branchFilters.length ? ` AND ${branchFilters.join(" AND ")}` : "";
  const localRankSql = localBoostExpression("s", query.preferLocal);

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT * FROM (
          SELECT
            s.*,
            f.relative_path AS relative_file,
            CASE WHEN lower(s.name) = ? OR lower(coalesce(s.class_name, '')) = ? THEN 1 ELSE 0 END AS exact_rank,
            CASE WHEN lower(s.name) LIKE ? ESCAPE '\\' OR lower(coalesce(s.class_name, '')) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS prefix_rank,
            CASE WHEN lower(s.name) LIKE ? ESCAPE '\\'
               OR lower(coalesce(s.class_name, '')) LIKE ? ESCAPE '\\'
               OR lower(coalesce(s.module, '')) LIKE ? ESCAPE '\\'
               OR lower(coalesce(s.signature, '')) LIKE ? ESCAPE '\\'
               OR lower(coalesce(s.description, '')) LIKE ? ESCAPE '\\'
            THEN 1 ELSE 0 END AS like_rank,
            ${localRankSql} AS local_rank,
            NULL AS rank
          FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE (exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1)${branchWhere}
          ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, local_rank DESC, s.name ASC
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT
            s.*,
            f.relative_path AS relative_file,
            0 AS exact_rank,
            0 AS prefix_rank,
            0 AS like_rank,
            ${localRankSql} AS local_rank,
            bm25(symbols_fts) AS rank
          FROM symbols_fts
          JOIN symbols s ON s.id = symbols_fts.rowid
          JOIN files f ON f.id = s.file_id
          WHERE symbols_fts MATCH ?${branchWhere}
          ORDER BY rank ASC, local_rank DESC
          LIMIT ?
        )
      )
      SELECT kind, type, language, name, module, class_name, file, relative_file, line, line_end, signature, description,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank, max(local_rank) AS local_rank
      FROM candidates
      GROUP BY kind, type, language, name, module, class_name, file, relative_file, line, line_end, signature, description
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, local_rank DESC, rank ASC, name ASC
      LIMIT ?
    `).all(exact, exact, prefix, prefix, like, like, like, like, like, ...filterParams, maxCandidates, fts, ...filterParams, maxCandidates, limit) as unknown as SymbolRow[];

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

export async function searchSqliteEvents(dbFile: string, query: LiveApiEventQuery): Promise<SearchResult<EventRecord>[] | undefined> {
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
  const maxCandidates = candidateLimit(limit);
  const filterParams: Array<string | number> = [];
  const branchFilters: string[] = [];
  if (query.module) {
    branchFilters.push("e.module = ?");
    filterParams.push(query.module);
  }
  const kinds = kindValues(query.kind);
  if (kinds.length) {
    branchFilters.push(`e.kind IN (${kinds.map(() => "?").join(", ")})`);
    filterParams.push(...kinds);
  }
  const branchWhere = branchFilters.length ? ` AND ${branchFilters.join(" AND ")}` : "";
  const localRankSql = localBoostExpression("e", query.preferLocal);

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT * FROM (
          SELECT
            e.*,
            f.relative_path AS relative_file,
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
            ${localRankSql} AS local_rank,
            NULL AS rank
          FROM events e
          JOIN files f ON f.id = e.file_id
          WHERE (exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1)${branchWhere}
          ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, local_rank DESC, e.name ASC
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT
            e.*,
            f.relative_path AS relative_file,
            0 AS exact_rank,
            0 AS prefix_rank,
            0 AS like_rank,
            ${localRankSql} AS local_rank,
            bm25(events_fts) AS rank
          FROM events_fts
          JOIN events e ON e.id = events_fts.rowid
          JOIN files f ON f.id = e.file_id
          WHERE events_fts MATCH ?${branchWhere}
          ORDER BY rank ASC, local_rank DESC
          LIMIT ?
        )
      )
      SELECT kind, module, name, handler_class, handler_method, handler_function, file, relative_file, line, signature, description,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank, max(local_rank) AS local_rank
      FROM candidates
      GROUP BY kind, module, name, handler_class, handler_method, handler_function, file, relative_file, line, signature, description
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, local_rank DESC, rank ASC, name ASC
      LIMIT ?
    `).all(exact, exact, prefix, prefix, like, like, like, like, like, like, like, like, ...filterParams, maxCandidates, fts, ...filterParams, maxCandidates, limit) as unknown as EventRow[];

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
  const maxCandidates = candidateLimit(limit);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT * FROM (
          SELECT d.uri, d.title, d.path, c.heading_path, c.section_anchor, c.source_uri, c.relative_path, c.chunk_index, c.text,
                 CASE WHEN lower(coalesce(d.title, '')) = ? THEN 1 ELSE 0 END AS exact_rank,
                 CASE WHEN lower(coalesce(d.title, '')) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS prefix_rank,
                 CASE WHEN lower(coalesce(d.title, '')) LIKE ? ESCAPE '\\' OR lower(c.text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS like_rank,
                 NULL AS rank
          FROM doc_chunks c
          JOIN docs d ON d.id = c.doc_id
          WHERE exact_rank = 1 OR prefix_rank = 1 OR like_rank = 1
          ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, d.uri ASC, c.chunk_index ASC
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT d.uri, d.title, d.path, c.heading_path, c.section_anchor, c.source_uri, c.relative_path, c.chunk_index, c.text,
                 0 AS exact_rank,
                 0 AS prefix_rank,
                 0 AS like_rank,
                 bm25(docs_fts) AS rank
          FROM docs_fts
          JOIN doc_chunks c ON c.id = docs_fts.rowid
          JOIN docs d ON d.id = c.doc_id
          WHERE docs_fts MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        )
      )
      SELECT uri, title, path, heading_path, section_anchor, source_uri, relative_path, chunk_index, text,
             min(rank) AS rank, max(exact_rank) AS exact_rank, max(prefix_rank) AS prefix_rank, max(like_rank) AS like_rank
      FROM candidates
      GROUP BY uri, title, path, heading_path, section_anchor, source_uri, relative_path, chunk_index, text
      ORDER BY exact_rank DESC, prefix_rank DESC, like_rank DESC, rank ASC, uri ASC, chunk_index ASC
      LIMIT ?
    `).all(exact, prefix, like, like, maxCandidates, fts, maxCandidates, limit) as unknown as DocRow[];

    return rows.map((row) => ({
      score: docScore(row),
      item: {
        uri: row.uri,
        title: row.title ?? undefined,
        path: row.path ?? undefined,
        headingPath: row.heading_path ?? undefined,
        sectionAnchor: row.section_anchor ?? undefined,
        sourceUri: row.source_uri ?? undefined,
        relativePath: row.relative_path ?? undefined,
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
