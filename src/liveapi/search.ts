import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase as openIndexDatabase } from "../indexer/database.js";
import { DOCS_FTS_WEIGHTS, EVENTS_FTS_WEIGHTS, SYMBOLS_FTS_WEIGHTS } from "../indexer/store/fts.js";
import { codeFtsQuery, proseFtsQuery } from "../search/textTokens.js";
import type { EventRecord, IndexKind, SearchResult, SymbolRecord } from "../types.js";

const openDatabase = (dbFile: string): DatabaseSync => openIndexDatabase(dbFile, { readOnly: true });

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
  id: number;
  kind: IndexKind;
  type: SymbolRecord["type"];
  language: string | null;
  name: string;
  module: string | null;
  class_name: string | null;
  fully_qualified_name: string | null;
  file: string;
  relative_file: string | null;
  line: number;
  line_end: number | null;
  signature: string | null;
  description: string | null;
  rank?: number | null;
}

interface EventRow {
  id: number;
  kind: IndexKind;
  module: string | null;
  name: string;
  handler_class: string | null;
  handler_method: string | null;
  handler_function: string | null;
  file: string;
  relative_file: string | null;
  line: number;
  signature: string | null;
  description: string | null;
  rank?: number | null;
}

interface DocRow {
  id: number;
  uri: string;
  title: string | null;
  path: string | null;
  heading_path: string | null;
  section_anchor: string | null;
  source_uri: string | null;
  relative_path: string | null;
  chunk_index: number;
  text: string;
  rank?: number | null;
}

/** Match quality tiers: exact name, name prefix, then full-text relevance. */
const EXACT_SCORE = 1;
const PREFIX_SCORE = 0.9;
const FTS_MAX_SCORE = 0.85;
const FTS_MIN_SCORE = 0.3;
/** bm25 multiplier for project/template results when preferLocal is on (bm25 is negative: larger magnitude = better). */
const LOCAL_BOOST = 1.25;

function candidateLimit(limit: number): number {
  return Math.max(100, Math.min(1_000, limit * 25));
}

function kindValues(kind: IndexKind | IndexKind[] | undefined): IndexKind[] {
  if (!kind) return [];
  return Array.isArray(kind) ? kind : [kind];
}

/** Upper bound for a case-insensitive prefix range scan on a NOCASE index. */
function prefixUpperBound(prefix: string): string {
  return `${prefix}￿`;
}

function isLocal(kind: IndexKind, preferLocal: boolean | undefined): boolean {
  return preferLocal !== false && (kind === "project" || kind === "template");
}

/** `Class::method` / `$obj->method` → `method`. */
function memberName(name: string): string {
  const match = name.match(/(?:::|->)([^:>]+)$/u);
  return match ? match[1] : name;
}

function matchTier(query: string, names: Array<string | null | undefined>): number {
  const needle = query.toLowerCase();
  const candidates = names.filter((name): name is string => Boolean(name)).flatMap((name) => [name.toLowerCase(), memberName(name).toLowerCase()]);
  if (candidates.some((candidate) => candidate === needle)) return EXACT_SCORE;
  if (candidates.some((candidate) => candidate.startsWith(needle))) return PREFIX_SCORE;
  return 0;
}

interface Ranked<T> {
  row: T;
  tier: number;
  rank: number;
  local: boolean;
}

/**
 * Merges index (exact/prefix) and FTS candidates by row id and orders them:
 * match tier first, then bm25 relevance with the local boost applied. FTS-only
 * results get a score scaled against the best bm25 in the result set.
 */
function rankRows<T extends { id: number; rank?: number | null }>(rows: T[], tierOf: (row: T) => number, localOf: (row: T) => boolean, limit: number): Array<{ row: T; score: number }> {
  const byId = new Map<number, Ranked<T>>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    const rank = row.rank ?? 0;
    if (existing) {
      existing.rank = Math.min(existing.rank, rank);
      continue;
    }
    byId.set(row.id, { row, tier: tierOf(row), rank, local: localOf(row) });
  }
  const boosted = (entry: Ranked<T>) => entry.rank * (entry.local ? LOCAL_BOOST : 1);
  const ranked = [...byId.values()].sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    // Within exact/prefix matches, local code first; FTS matches carry the local boost in their bm25.
    if (a.tier > 0 && a.local !== b.local) return a.local ? -1 : 1;
    return boosted(a) - boosted(b) || a.row.id - b.row.id;
  });
  const best = Math.min(0, ...ranked.filter((entry) => entry.tier === 0).map(boosted));
  return ranked.slice(0, limit).map((entry) => ({
    row: entry.row,
    score: entry.tier > 0 ? entry.tier : best < 0 ? Math.max(FTS_MIN_SCORE, FTS_MAX_SCORE * (boosted(entry) / best)) : FTS_MIN_SCORE
  }));
}

function isFtsSyntaxError(error: unknown): boolean {
  const message = (error as Error).message ?? "";
  return message.includes("fts5") || message.includes("MATCH");
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
    fullyQualifiedName: row.fully_qualified_name ?? undefined,
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

const SYMBOL_COLUMNS = "s.id, s.kind, s.type, s.language, s.name, s.module, s.class_name, s.fully_qualified_name, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description";

/**
 * Symbol search: exact and prefix matches on the symbol or class name (NOCASE
 * indexes), plus FTS over names, their camelCase/namespace parts, FQNs,
 * signatures and descriptions, ranked with column-weighted bm25.
 */
export async function searchSqliteLiveApi(dbFile: string, query: LiveApiQuery): Promise<SearchResult<SymbolRecord>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  const text = query.query.trim();
  if (!text) return [];

  const limit = query.limit ?? 20;
  const maxCandidates = candidateLimit(limit);
  const filters: string[] = [];
  const filterParams: Array<string | number> = [];
  if (query.type) {
    filters.push("s.type = ?");
    filterParams.push(query.type);
  }
  if (query.module) {
    filters.push("s.module = ?");
    filterParams.push(query.module);
  }
  const kinds = kindValues(query.kind);
  if (kinds.length) {
    filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
    filterParams.push(...kinds);
  }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      SELECT ${SYMBOL_COLUMNS}, NULL AS rank
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (s.name = ? COLLATE NOCASE OR s.class_name = ? COLLATE NOCASE OR (s.name >= ? COLLATE NOCASE AND s.name < ? COLLATE NOCASE))${where}
      LIMIT ?
    `).all(text, text, text, prefixUpperBound(text), ...filterParams, maxCandidates) as unknown as SymbolRow[];

    const fts = codeFtsQuery(text);
    if (fts) {
      try {
        rows.push(...db.prepare(`
          SELECT ${SYMBOL_COLUMNS}, bm25(symbols_fts, ${SYMBOLS_FTS_WEIGHTS}) AS rank
          FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
          WHERE symbols_fts MATCH ?${where}
          ORDER BY rank
          LIMIT ?
        `).all(fts, ...filterParams, maxCandidates) as unknown as SymbolRow[]);
      } catch (error) {
        if (!isFtsSyntaxError(error)) throw error;
      }
    }

    return rankRows(rows, (row) => matchTier(text, [row.name, row.class_name, row.fully_qualified_name]), (row) => isLocal(row.kind, query.preferLocal), limit)
      .map(({ row, score }) => ({ score, item: rowToSymbol(row) }));
  } finally {
    db.close();
  }
}

const EVENT_COLUMNS = "e.id, e.kind, e.module, e.name, e.handler_class, e.handler_method, e.handler_function, e.file, f.relative_path AS relative_file, e.line, e.signature, e.description";

/** Event search: exact/prefix on the event name (or `module:Event`), plus weighted FTS over names, handlers and signatures. */
export async function searchSqliteEvents(dbFile: string, query: LiveApiEventQuery): Promise<SearchResult<EventRecord>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  const text = query.query.trim();
  if (!text) return [];

  const moduleQualified = text.match(/^([\w.]+):(\w+)$/u);
  const eventName = moduleQualified ? moduleQualified[2] : text;
  const limit = query.limit ?? 20;
  const maxCandidates = candidateLimit(limit);
  const filters: string[] = [];
  const filterParams: Array<string | number> = [];
  const moduleFilter = query.module ?? moduleQualified?.[1];
  if (moduleFilter) {
    filters.push("e.module = ?");
    filterParams.push(moduleFilter);
  }
  const kinds = kindValues(query.kind);
  if (kinds.length) {
    filters.push(`e.kind IN (${kinds.map(() => "?").join(", ")})`);
    filterParams.push(...kinds);
  }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      SELECT ${EVENT_COLUMNS}, NULL AS rank
      FROM events e JOIN files f ON f.id = e.file_id
      WHERE (e.name = ? COLLATE NOCASE OR (e.name >= ? COLLATE NOCASE AND e.name < ? COLLATE NOCASE))${where}
      LIMIT ?
    `).all(eventName, eventName, prefixUpperBound(eventName), ...filterParams, maxCandidates) as unknown as EventRow[];

    const fts = codeFtsQuery(moduleQualified ? eventName : text);
    if (fts) {
      try {
        rows.push(...db.prepare(`
          SELECT ${EVENT_COLUMNS}, bm25(events_fts, ${EVENTS_FTS_WEIGHTS}) AS rank
          FROM events_fts JOIN events e ON e.id = events_fts.rowid JOIN files f ON f.id = e.file_id
          WHERE events_fts MATCH ?${where}
          ORDER BY rank
          LIMIT ?
        `).all(fts, ...filterParams, maxCandidates) as unknown as EventRow[]);
      } catch (error) {
        if (!isFtsSyntaxError(error)) throw error;
      }
    }

    return rankRows(rows, (row) => matchTier(eventName, [row.name]), (row) => isLocal(row.kind, query.preferLocal), limit)
      .map(({ row, score }) => ({ score, item: rowToEvent(row) }));
  } finally {
    db.close();
  }
}

const DOC_COLUMNS = "c.id, d.uri, d.title, d.path, c.heading_path, c.section_anchor, c.source_uri, c.relative_path, c.chunk_index, c.text";

/**
 * Documentation search: exact/prefix title matches, plus FTS with the porter
 * stemmer for English and Snowball stems for Russian (`событий` finds
 * `событие`), weighted towards titles and headings.
 */
export async function searchSqliteDocs(dbFile: string, query: { query: string; limit?: number }): Promise<SearchResult<DocSearchResult>[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  const text = query.query.trim();
  if (!text) return [];

  const limit = query.limit ?? 5;
  const maxCandidates = candidateLimit(limit);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare(`
      SELECT ${DOC_COLUMNS}, NULL AS rank
      FROM docs d JOIN doc_chunks c ON c.doc_id = d.id
      WHERE (d.title = ? COLLATE NOCASE OR (d.title >= ? COLLATE NOCASE AND d.title < ? COLLATE NOCASE)) AND c.chunk_index = 0
      LIMIT ?
    `).all(text, text, prefixUpperBound(text), maxCandidates) as unknown as DocRow[];

    const fts = proseFtsQuery(text);
    if (fts) {
      try {
        rows.push(...db.prepare(`
          SELECT ${DOC_COLUMNS}, bm25(docs_fts, ${DOCS_FTS_WEIGHTS}) AS rank
          FROM docs_fts JOIN doc_chunks c ON c.id = docs_fts.rowid JOIN docs d ON d.id = c.doc_id
          WHERE docs_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(fts, maxCandidates) as unknown as DocRow[]);
      } catch (error) {
        if (!isFtsSyntaxError(error)) throw error;
      }
    }

    return rankRows(rows, (row) => matchTier(text, [row.title]), () => false, limit).map(({ row, score }) => ({
      score,
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
  } finally {
    db.close();
  }
}
