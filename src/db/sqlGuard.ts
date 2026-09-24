/**
 * A small MySQL/MariaDB lexer and the read-only statement policy built on it.
 *
 * The policy is a best-effort filter for `bitrix_db_query`, applied before the
 * statement runs inside a `READ ONLY` transaction. It is not a substitute for a
 * database account that only has `SELECT` privileges.
 */

export type SqlTokenType = "word" | "string" | "quoted_identifier" | "number" | "variable" | "symbol";

export interface SqlToken {
  type: SqlTokenType;
  /** Upper-cased for `word` tokens, raw text otherwise. */
  value: string;
  start: number;
  end: number;
  /** Parenthesis depth at which the token appears. */
  depth: number;
}

export interface SqlLexResult {
  tokens: SqlToken[];
  /** True when the source contains a MySQL/MariaDB executable comment (`/*!…*\/`, `/*M!…*\/`). */
  hasExecutableComment: boolean;
}

const WORD_START = /[A-Za-z_$\u0080-￿]/u;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/u;

function readQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "\\" && quote !== "`") {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw new Error("SQL guard: unterminated quoted string or identifier.");
}

/** Tokenizes `sql`, skipping whitespace and comments and tracking string/identifier quoting. */
export function lexSql(sql: string): SqlLexResult {
  const tokens: SqlToken[] = [];
  let hasExecutableComment = false;
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "#" || (char === "-" && next === "-" && (index + 2 >= sql.length || /\s/u.test(sql[index + 2])))) {
      const lineEnd = sql.indexOf("\n", index);
      index = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      if (sql[index + 2] === "!" || (sql[index + 2] === "M" && sql[index + 3] === "!")) hasExecutableComment = true;
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd === -1) throw new Error("SQL guard: unterminated block comment.");
      index = commentEnd + 2;
      continue;
    }
    if (char === "'" || char === "\"") {
      const end = readQuoted(sql, index, char);
      tokens.push({ type: "string", value: sql.slice(index, end), start: index, end, depth });
      index = end;
      continue;
    }
    if (char === "`") {
      const end = readQuoted(sql, index, char);
      tokens.push({ type: "quoted_identifier", value: sql.slice(index, end), start: index, end, depth });
      index = end;
      continue;
    }
    if (char === "@") {
      let end = index + 1;
      if (sql[end] === "@") end += 1;
      while (end < sql.length && (WORD_PART.test(sql[end]) || sql[end] === ".")) end += 1;
      tokens.push({ type: "variable", value: sql.slice(index, end), start: index, end, depth });
      index = end;
      continue;
    }
    if (/[0-9]/u.test(char) || (char === "." && next !== undefined && /[0-9]/u.test(next))) {
      let end = index + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/u.test(sql[end])) end += 1;
      tokens.push({ type: "number", value: sql.slice(index, end), start: index, end, depth });
      index = end;
      continue;
    }
    if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < sql.length && WORD_PART.test(sql[end])) end += 1;
      tokens.push({ type: "word", value: sql.slice(index, end).toUpperCase(), start: index, end, depth });
      index = end;
      continue;
    }
    if (char === ")") depth = Math.max(0, depth - 1);
    tokens.push({ type: "symbol", value: char, start: index, end: index + 1, depth });
    if (char === "(") depth += 1;
    index += 1;
  }

  return { tokens, hasExecutableComment };
}

const READ_ONLY_FIRST_KEYWORDS = new Set(["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH"]);

/**
 * Keywords that turn a read into a write, a lock, or a file operation. They are
 * rejected anywhere in the statement unless used as a function name (followed by
 * `(`, e.g. the `INSERT()`/`REPLACE()` string functions).
 */
const FORBIDDEN_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT",
  "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME",
  "GRANT", "REVOKE", "CALL", "LOAD", "LOCK", "UNLOCK",
  "INTO", "OUTFILE", "DUMPFILE", "HANDLER", "KILL", "SHUTDOWN", "FLUSH", "PURGE", "RESET", "INSTALL", "UNINSTALL"
]);

/** Functions with side effects, file access, or that can stall the server. */
const FORBIDDEN_FUNCTIONS = new Set([
  "LOAD_FILE", "SLEEP", "BENCHMARK",
  "GET_LOCK", "RELEASE_LOCK", "RELEASE_ALL_LOCKS",
  "MASTER_POS_WAIT", "SOURCE_POS_WAIT", "MASTER_GTID_WAIT", "WAIT_FOR_EXECUTED_GTID_SET", "WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS",
  "NEXTVAL", "SETVAL", "SYS_EXEC", "SYS_EVAL"
]);

function isFunctionCall(tokens: SqlToken[], index: number): boolean {
  const next = tokens[index + 1];
  return next !== undefined && next.type === "symbol" && next.value === "(";
}

function isQualifiedName(tokens: SqlToken[], index: number): boolean {
  const previous = tokens[index - 1];
  const next = tokens[index + 1];
  return (previous?.type === "symbol" && previous.value === ".") || (next?.type === "symbol" && next.value === "." && next.start === tokens[index].end);
}

/**
 * Throws unless `sql` is a single read-only statement: it must start with
 * SELECT/SHOW/EXPLAIN/DESCRIBE/WITH, contain no executable comments, no
 * write/lock/file keywords (`WITH … DELETE`, `INTO OUTFILE`, `FOR UPDATE`,
 * `LOCK IN SHARE MODE`, …), and no side-effecting functions (`LOAD_FILE`,
 * `SLEEP`, `BENCHMARK`, `GET_LOCK`, …). Returns the lexed tokens.
 */
export function assertReadOnlySql(sql: string): SqlToken[] {
  const { tokens, hasExecutableComment } = lexSql(sql);
  if (hasExecutableComment) {
    throw new Error("Read-only mode: executable comments (/*! … */) are not allowed.");
  }

  const semicolon = tokens.findIndex((token) => token.type === "symbol" && token.value === ";");
  if (semicolon !== -1 && tokens.slice(semicolon + 1).some((token) => !(token.type === "symbol" && token.value === ";"))) {
    throw new Error("Read-only mode: only a single SQL statement is allowed.");
  }
  const statement = semicolon === -1 ? tokens : tokens.slice(0, semicolon);

  const first = statement[0];
  if (!first || first.type !== "word" || !READ_ONLY_FIRST_KEYWORDS.has(first.value)) {
    throw new Error("Read-only mode: only SELECT/SHOW/EXPLAIN/DESCRIBE/WITH statements are allowed. Enable BITRIX_MCP_DB_ALLOW_WRITE=1 and use bitrix_db_execute for writes.");
  }

  // SHOW CREATE TABLE/VIEW/… is a read; CREATE is otherwise a DDL keyword.
  const allowedKeywords = first.value === "SHOW" ? new Set(["CREATE"]) : new Set<string>();
  statement.forEach((token, index) => {
    if (token.type !== "word" || isQualifiedName(statement, index)) return;
    if (isFunctionCall(statement, index)) {
      if (FORBIDDEN_FUNCTIONS.has(token.value)) {
        throw new Error(`Read-only mode: function ${token.value}() is not allowed.`);
      }
      return;
    }
    if (FORBIDDEN_KEYWORDS.has(token.value) && !allowedKeywords.has(token.value)) {
      throw new Error(`Read-only mode: keyword ${token.value} is not allowed in a read-only query.`);
    }
  });

  return statement;
}

/**
 * Returns `sql` with a top-level `LIMIT <limit>` appended when it is a
 * SELECT/WITH statement without a top-level LIMIT; otherwise `undefined`.
 * Trailing comments and semicolons are dropped so they cannot swallow the clause.
 */
export function appendTopLevelLimit(sql: string, statement: SqlToken[], limit: number): string | undefined {
  const first = statement[0];
  if (!first || (first.value !== "SELECT" && first.value !== "WITH")) return undefined;
  if (statement.some((token) => token.type === "word" && token.depth === 0 && token.value === "LIMIT")) return undefined;
  const last = statement[statement.length - 1];
  return `${sql.slice(0, last.end)} LIMIT ${limit}`;
}
