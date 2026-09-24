import type { Connection as CoreConnection } from "mysql2";
import mysql from "mysql2/promise";
import { appendTopLevelLimit, assertReadOnlySql } from "./sqlGuard.js";
import type { BitrixConnection, QueryResult, SchemaColumn, SchemaResult, SchemaTable } from "./types.js";

const DEFAULT_MYSQL_PORT = 3306;
const DEFAULT_ROW_LIMIT = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 15000;
const DEFAULT_TABLE_LIMIT = 200;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESULT_BYTES = 1_000_000;

export interface RunQueryOptions {
  readOnly: boolean;
  rowLimit?: number;
  timeoutMs?: number;
  /** Approximate cap on the JSON size of returned rows (read-only mode); default 1 MB. */
  maxBytes?: number;
}

export interface GetSchemaOptions {
  table?: string;
  prefix?: string;
  limit?: number;
}

interface InformationSchemaTableRow {
  TABLE_NAME: string;
  ENGINE: string | null;
  TABLE_ROWS: number | string | null;
}

interface InformationSchemaColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_KEY: string | null;
  COLUMN_DEFAULT: string | null;
  EXTRA: string | null;
}

/**
 * Opens a fresh mysql2 connection for `conn`. Callers are responsible for
 * closing it. BIGINT/DECIMAL values come back as strings (no precision loss)
 * and DATE/DATETIME values as the database's literal text.
 */
async function openConnection(conn: BitrixConnection) {
  if (conn.className && /pgsql|postgres/iu.test(conn.className)) {
    throw new Error(`Connection "${conn.name}" uses ${conn.className}; PostgreSQL connections are not supported yet (MySQL/MariaDB only).`);
  }
  return mysql.createConnection({
    ...(conn.socketPath ? { socketPath: conn.socketPath } : { host: conn.host, port: conn.port ?? DEFAULT_MYSQL_PORT }),
    user: conn.login,
    password: conn.password,
    database: conn.database,
    charset: conn.charset,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS
  });
}

type PromiseConnection = Awaited<ReturnType<typeof openConnection>>;

/** The callback-style connection behind a promise connection (needed for row streaming and the thread id). */
function coreConnection(connection: PromiseConnection): CoreConnection {
  return (connection as unknown as { connection: CoreConnection }).connection;
}

/** Best-effort `KILL QUERY` from a second connection, so a timed-out or abandoned statement stops on the server too. */
async function killQuery(conn: BitrixConnection, threadId: number | null | undefined): Promise<void> {
  if (!threadId) return;
  let killer: PromiseConnection | undefined;
  try {
    killer = await openConnection(conn);
    await killer.query(`KILL QUERY ${Number(threadId)}`);
  } catch {
    // The statement may already have finished, or the account may lack the privilege.
  } finally {
    await killer?.end().catch(() => undefined);
  }
}

/** Asks the server to abort statements that run longer than `timeoutMs` (MariaDB, then MySQL syntax). */
async function setServerStatementTimeout(connection: PromiseConnection, timeoutMs: number): Promise<void> {
  try {
    await connection.query(`SET SESSION max_statement_time = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`);
    return;
  } catch {
    // Not MariaDB.
  }
  try {
    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(timeoutMs))}`);
  } catch {
    // Unsupported server; the client-side timeout plus KILL QUERY still applies.
  }
}

const MAX_CELL_CHARS = 4000;
const BINARY_PREVIEW_BYTES = 32;

function truncateText(text: string): string {
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}… [truncated, ${text.length} chars]` : text;
}

/** Renders a cell value as compact JSON-safe data: BLOBs as text or a short hex preview, long strings truncated. */
export function normalizeCellValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    // eslint-disable-next-line no-control-regex
    if (!text.includes("�") && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) return truncateText(text);
    const preview = value.subarray(0, BINARY_PREVIEW_BYTES).toString("hex");
    return `<binary ${value.length} bytes: ${preview}${value.length > BINARY_PREVIEW_BYTES ? "…" : ""}>`;
  }
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) normalized[key] = normalizeCellValue(value);
  return normalized;
}

interface StreamedRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncatedReason?: "rows" | "bytes";
}

/**
 * Streams the result of a read statement, keeping at most `rowLimit` rows and
 * roughly `maxBytes` of JSON. When a cap is hit the rest of the result is not
 * read; the caller must then kill the query and destroy the connection.
 */
function streamRows(connection: PromiseConnection, sql: string, rowLimit: number, maxBytes: number, timeoutMs: number): Promise<StreamedRows> {
  const core = coreConnection(connection);
  return new Promise<StreamedRows>((resolve, reject) => {
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: StreamedRows | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`Query exceeded timeout of ${timeoutMs}ms and was cancelled.`)), timeoutMs);
    timer.unref?.();

    const query = core.query({ sql });
    query.on("fields", (fields: Array<{ name: string }> | undefined) => {
      if (Array.isArray(fields)) columns = fields.map((field) => field.name);
    });
    query.on("result", (row: unknown) => {
      if (settled || typeof row !== "object" || row === null || Array.isArray(row) || "affectedRows" in row) return;
      if (rows.length >= rowLimit) {
        core.pause();
        finish({ columns, rows, truncatedReason: "rows" });
        return;
      }
      const normalized = normalizeRow(row as Record<string, unknown>);
      const size = JSON.stringify(normalized).length;
      if (rows.length > 0 && bytes + size > maxBytes) {
        core.pause();
        finish({ columns, rows, truncatedReason: "bytes" });
        return;
      }
      rows.push(normalized);
      bytes += size;
    });
    query.on("error", (error: Error) => finish(error));
    query.on("end", () => finish({ columns, rows }));
  });
}

async function runReadOnlyQuery(conn: BitrixConnection, sql: string, rowLimit: number, timeoutMs: number, maxBytes: number): Promise<QueryResult> {
  const statement = assertReadOnlySql(sql);
  const executedSql = appendTopLevelLimit(sql, statement, rowLimit + 1) ?? sql;

  const connection = await openConnection(conn);
  const threadId = coreConnection(connection).threadId;
  let clean = false;
  try {
    await setServerStatementTimeout(connection, timeoutMs);
    // Defence in depth: table writes fail inside a READ ONLY transaction even if a statement slips past the guard.
    await connection.query("START TRANSACTION READ ONLY");
    const { columns, rows, truncatedReason } = await streamRows(connection, executedSql, rowLimit, maxBytes, timeoutMs);
    if (!truncatedReason) {
      await connection.query("ROLLBACK");
      clean = true;
    }
    return {
      columns: columns.length > 0 ? columns : Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      truncated: truncatedReason !== undefined,
      ...(truncatedReason ? { truncatedReason } : {})
    };
  } finally {
    if (clean) {
      await connection.end().catch(() => undefined);
    } else {
      await killQuery(conn, threadId);
      connection.destroy();
    }
  }
}

/**
 * Executes `sql` against the live Bitrix MySQL/MariaDB database described by
 * `conn` over a fresh connection, closed on completion.
 *
 * Read-only mode rejects anything {@link assertReadOnlySql} does not accept,
 * runs the statement inside `START TRANSACTION READ ONLY … ROLLBACK` with a
 * server-side statement timeout, streams at most `opts.rowLimit` rows
 * (default 500) and about `opts.maxBytes` of JSON (default 1 MB), and kills the
 * query on the server when it times out or a cap is hit. Write mode returns
 * `affectedRows`.
 */
export async function runQuery(conn: BitrixConnection, sql: string, opts: RunQueryOptions): Promise<QueryResult> {
  const rowLimit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  if (opts.readOnly) {
    return runReadOnlyQuery(conn, sql, rowLimit, timeoutMs, opts.maxBytes ?? DEFAULT_MAX_RESULT_BYTES);
  }

  const connection = await openConnection(conn);
  try {
    const [rows, fields] = await connection.query({ sql, timeout: timeoutMs });
    if (Array.isArray(rows)) {
      const allRows = (rows as Array<Record<string, unknown>>).map(normalizeRow);
      const slicedRows = allRows.slice(0, rowLimit);
      return {
        columns: Array.isArray(fields) && fields.length > 0 ? fields.map((field) => field.name) : Object.keys(slicedRows[0] ?? {}),
        rows: slicedRows,
        rowCount: slicedRows.length,
        truncated: allRows.length > rowLimit
      };
    }
    const okPacket = rows as { affectedRows?: number };
    return { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: okPacket.affectedRows };
  } finally {
    await connection.end();
  }
}

function toSchemaColumn(row: InformationSchemaColumnRow): SchemaColumn {
  return {
    name: row.COLUMN_NAME,
    type: row.COLUMN_TYPE,
    nullable: row.IS_NULLABLE === "YES",
    key: row.COLUMN_KEY || undefined,
    default: row.COLUMN_DEFAULT,
    extra: row.EXTRA || undefined
  };
}

/**
 * Introspects the schema of `conn.database` on the live Bitrix MySQL
 * database: lists tables (optionally filtered to a single `opts.table` or by
 * `opts.prefix`) up to `opts.limit` (default 200), and for each matched table
 * fetches its columns from `information_schema.columns` in a single batched
 * query. Uses one connection for all queries, closed on completion.
 */
export { assertReadOnlySql };

export async function getSchema(conn: BitrixConnection, opts: GetSchemaOptions): Promise<SchemaResult> {
  const tableLimit = opts.limit ?? DEFAULT_TABLE_LIMIT;

  const connection = await openConnection(conn);
  try {
    const tableConditions: string[] = ["table_schema = ?"];
    const tableParams: unknown[] = [conn.database];

    if (opts.table) {
      tableConditions.push("table_name = ?");
      tableParams.push(opts.table);
    } else if (opts.prefix) {
      tableConditions.push("table_name LIKE ?");
      tableParams.push(`${opts.prefix}%`);
    }

    const [tableRows] = await connection.query(
      `SELECT table_name AS TABLE_NAME, engine AS ENGINE, table_rows AS TABLE_ROWS
       FROM information_schema.tables
       WHERE ${tableConditions.join(" AND ")}
       ORDER BY table_name
       LIMIT ?`,
      [...tableParams, tableLimit + 1]
    );

    const allTableRows = tableRows as InformationSchemaTableRow[];
    const truncated = allTableRows.length > tableLimit;
    const matchedTableRows = truncated ? allTableRows.slice(0, tableLimit) : allTableRows;
    const tableNames = matchedTableRows.map((row) => row.TABLE_NAME);

    if (tableNames.length === 0) {
      return { database: conn.database, tables: [], truncated };
    }

    const placeholders = tableNames.map(() => "?").join(", ");
    const [columnRows] = await connection.query(
      `SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME, column_type AS COLUMN_TYPE,
              is_nullable AS IS_NULLABLE, column_key AS COLUMN_KEY, column_default AS COLUMN_DEFAULT,
              extra AS EXTRA
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN (${placeholders})
       ORDER BY table_name, ordinal_position`,
      [conn.database, ...tableNames]
    );

    const columnsByTable = new Map<string, SchemaColumn[]>();
    for (const row of columnRows as InformationSchemaColumnRow[]) {
      const columns = columnsByTable.get(row.TABLE_NAME) ?? [];
      columns.push(toSchemaColumn(row));
      columnsByTable.set(row.TABLE_NAME, columns);
    }

    const tables: SchemaTable[] = matchedTableRows.map((row) => ({
      name: row.TABLE_NAME,
      engine: row.ENGINE ?? undefined,
      rows: row.TABLE_ROWS === null ? undefined : Number(row.TABLE_ROWS),
      columns: columnsByTable.get(row.TABLE_NAME) ?? []
    }));

    return { database: conn.database, tables, truncated };
  } finally {
    await connection.end();
  }
}
