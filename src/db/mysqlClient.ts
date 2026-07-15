import mysql from "mysql2/promise";
import type { BitrixConnection, QueryResult, SchemaColumn, SchemaResult, SchemaTable } from "./types.js";

const DEFAULT_MYSQL_PORT = 3306;
const DEFAULT_ROW_LIMIT = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 15000;
const DEFAULT_TABLE_LIMIT = 200;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

const READ_ONLY_KEYWORDS = new Set(["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH"]);

export interface RunQueryOptions {
  readOnly: boolean;
  rowLimit?: number;
  timeoutMs?: number;
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
 * Strips SQL line comments (`-- ...` to end of line) and block comments
 * (`/* ... *\/`) from `sql`. This is a conservative, non-tokenizing scan: it
 * does not track string-literal state, so a `--` or `/*` occurring inside a
 * quoted string literal will also be stripped. Acceptable for the read-only
 * gate this feeds, which only inspects statement shape, but callers must not
 * rely on this for anything that needs to preserve string literal contents.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Validates that `sql` is a single, read-only statement: only
 * SELECT/SHOW/EXPLAIN/DESCRIBE/DESC/WITH statements are permitted, and only
 * one statement (a single trailing `;` is tolerated) may be present. Comments
 * are stripped before inspection per the limitations of {@link stripSqlComments}.
 * Throws when the statement is a write, is unrecognized, or stacks multiple
 * statements.
 */
export function assertReadOnlySql(sql: string): void {
  const normalized = stripSqlComments(sql).trim();

  const semicolonIndex = normalized.indexOf(";");
  if (semicolonIndex !== -1 && normalized.slice(semicolonIndex + 1).trim().length > 0) {
    throw new Error("Read-only mode: only a single SQL statement is allowed.");
  }

  const keywordMatch = normalized.match(/^([A-Za-z]+)/);
  const firstKeyword = keywordMatch?.[1]?.toUpperCase() ?? "";

  if (!READ_ONLY_KEYWORDS.has(firstKeyword)) {
    throw new Error("Read-only mode: only SELECT/SHOW/EXPLAIN/DESCRIBE/WITH statements are allowed. Enable BITRIX_MCP_DB_ALLOW_WRITE=1 and use bitrix_db_execute for writes.");
  }
}

/**
 * Opens a fresh mysql2 connection for `conn`. Callers are responsible for
 * closing the connection (via `conn.end()`) once finished; there is no shared
 * pool.
 */
async function openConnection(conn: BitrixConnection) {
  return mysql.createConnection({
    host: conn.host,
    port: conn.port ?? DEFAULT_MYSQL_PORT,
    user: conn.login,
    password: conn.password,
    database: conn.database,
    multipleStatements: false,
    connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS
  });
}

function hasLimitClause(sql: string): boolean {
  return /\blimit\b/i.test(sql);
}

/**
 * Appends a `LIMIT <rowLimit + 1>` clause to `sql` when it is a bare
 * SELECT/WITH statement without an existing `LIMIT`, so truncation can be
 * detected after execution. Statements that already specify a `LIMIT`, or
 * that are not SELECT/WITH (e.g. SHOW/EXPLAIN/DESCRIBE), are returned
 * unchanged.
 */
function applyRowLimit(sql: string, rowLimit: number): string {
  const trimmed = sql.trim();
  const keywordMatch = trimmed.match(/^([A-Za-z]+)/);
  const firstKeyword = keywordMatch?.[1]?.toUpperCase() ?? "";
  if (firstKeyword !== "SELECT" && firstKeyword !== "WITH") return sql;
  if (hasLimitClause(trimmed)) return sql;

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  return `${withoutTrailingSemicolon} LIMIT ${rowLimit + 1}`;
}

/**
 * Executes `sql` against the live Bitrix MySQL database described by `conn`
 * over a fresh connection, closed on completion. In read-only mode, rejects
 * any non-SELECT/SHOW/EXPLAIN/DESCRIBE/WITH statement via
 * {@link assertReadOnlySql}. Read statements are capped at `opts.rowLimit`
 * (default 500) rows, with `truncated` set when more rows were available;
 * write statements return `affectedRows` from the resulting OkPacket.
 */
export async function runQuery(conn: BitrixConnection, sql: string, opts: RunQueryOptions): Promise<QueryResult> {
  if (opts.readOnly) {
    assertReadOnlySql(sql);
  }

  const rowLimit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const executedSql = opts.readOnly ? applyRowLimit(sql, rowLimit) : sql;

  const connection = await openConnection(conn);
  try {
    const [rows, fields] = await connection.query({ sql: executedSql, timeout: timeoutMs });

    if (Array.isArray(rows)) {
      const allRows = rows as Array<Record<string, unknown>>;
      const truncated = executedSql !== sql && allRows.length > rowLimit;
      const slicedRows = truncated ? allRows.slice(0, rowLimit) : allRows;
      const columns = Array.isArray(fields) && fields.length > 0
        ? fields.map((field) => field.name)
        : Object.keys(slicedRows[0] ?? {});

      return {
        columns,
        rows: slicedRows,
        rowCount: slicedRows.length,
        truncated
      };
    }

    const okPacket = rows as { affectedRows?: number };
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      affectedRows: okPacket.affectedRows
    };
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
