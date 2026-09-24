import { z } from "zod";

/**
 * Uniform result envelope for search/list tools. `count` is the number of
 * results on this page; `total` is present only when the end of the result set
 * was reached (so it is exact); `truncated` is true whenever more results
 * exist than were returned, and `nextCursor` fetches the next page when the
 * pagination window allows it.
 */
export interface ResultEnvelope<T = unknown> {
  count: number;
  total?: number;
  truncated: boolean;
  nextCursor?: string;
  results: T[];
  entity?: string;
  warnings?: string[];
}

/** Deepest result offset reachable through cursors; SQLite search helpers cap one read at 500 rows. */
export const MAX_PAGE_WINDOW = 500;

/**
 * Ranked searches (liveapi/events/docs) size their FTS candidate pool from the
 * requested limit. Reading at least this many rows keeps the pool, and so the
 * ranking, identical across pages.
 */
export const RANKED_MIN_FETCH = 40;

/** Output schema of search/list tools; the fields are explained once in the server instructions. */
export const resultEnvelopeShape = {
  count: z.number().int(),
  total: z.number().int().optional(),
  truncated: z.boolean(),
  nextCursor: z.string().optional(),
  results: z.array(z.record(z.string(), z.unknown())),
  entity: z.string().optional(),
  warnings: z.array(z.string()).optional()
};

export const cursorSchema = z.string().max(200).optional().describe("nextCursor from the previous page.");

export interface PageRequest {
  offset: number;
  limit: number;
  /** Rows to read from the store: offset + limit + 1 (the extra row tells "more" from "end"), capped by the window. */
  fetch: number;
  /** Largest row count the underlying store returns for one read. */
  window: number;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/** Decodes a cursor into a result offset; undefined/empty means the first page. */
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.o < MAX_PAGE_WINDOW) {
      return parsed.o;
    }
  } catch {
    // fall through to the error below
  }
  throw new Error("Invalid cursor: pass the nextCursor value from a previous response unchanged.");
}

export function pageRequest(limit: number, offset = 0, options: { minFetch?: number; window?: number } = {}): PageRequest {
  const safeLimit = Math.max(1, Math.floor(limit));
  const window = Math.min(MAX_PAGE_WINDOW, options.window ?? MAX_PAGE_WINDOW);
  const fetch = Math.min(window, Math.max(options.minFetch ?? 0, offset + safeLimit + 1));
  return { offset, limit: safeLimit, fetch, window };
}

/** A single unpaginated page holding every row (for small list results). */
export const WHOLE_LIST: PageRequest = { offset: 0, limit: Number.MAX_SAFE_INTEGER, fetch: Number.MAX_SAFE_INTEGER, window: Number.MAX_SAFE_INTEGER };

/**
 * Cuts one page out of `rows` (read from offset 0 with `page.fetch` as the
 * limit) and builds the envelope. `format` maps the page rows to output rows.
 */
export function paginate<T>(rows: T[] | undefined, page: PageRequest, format: (rows: T[]) => unknown[] | undefined = (items) => items, extra: { entity?: string; warnings?: string[] } = {}): ResultEnvelope<Record<string, unknown>> {
  const all = rows ?? [];
  const end = page.offset + page.limit;
  const pageRows = all.slice(page.offset, end);
  const results = (format(pageRows) ?? []) as Array<Record<string, unknown>>;
  const warnings = [...(extra.warnings ?? [])];
  const hasMore = all.length > end;
  // A read that filled the capped window may hide more rows beyond it.
  const windowFull = page.fetch >= page.window && all.length >= page.window;
  const truncated = hasMore || windowFull;
  let nextCursor: string | undefined;
  if (hasMore && end < page.window) {
    nextCursor = encodeCursor(end);
  } else if (truncated) {
    warnings.push(`Pagination window of ${page.window} results reached; narrow the query with filters.`);
  }
  return {
    ...(extra.entity ? { entity: extra.entity } : {}),
    count: results.length,
    ...(truncated ? {} : { total: all.length }),
    truncated,
    ...(nextCursor ? { nextCursor } : {}),
    results,
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

/** Text + structured tool result: compact JSON text for clients that ignore structuredContent. */
export function structuredResult(value: ResultEnvelope | Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as unknown as Record<string, unknown> };
}

/** Compact (non-indented) JSON text tool result. */
export function jsonResult(value: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}
