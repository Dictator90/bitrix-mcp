import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../config/paths.js";
import type { BitrixConnection, RedactedConnection } from "../db/types.js";
import { literalValue, parsePhpToAst } from "./phpAstParser.js";

type PhpNode = { kind: string; loc?: unknown; [key: string]: unknown };

function isPhpNode(value: unknown): value is PhpNode {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

/**
 * Locates the top-level `return array(...)` expression in a parsed
 * `.settings.php` AST and returns its `array` node, or `undefined` if the
 * file has no top-level return statement.
 */
function findReturnExpression(ast: PhpNode): PhpNode | undefined {
  const children = Array.isArray(ast.children) ? ast.children.filter(isPhpNode) : [];
  const returnNode = children.find((child) => child.kind === "return");
  const expr = returnNode?.expr;
  return isPhpNode(expr) ? expr : undefined;
}

/**
 * Splits a Bitrix `host` value into host/port or a Unix socket path. Accepts
 * `host`, `host:3306`, `localhost:/run/mysqld/mysqld.sock`, `:/path.sock`, and
 * a bare `/path.sock`.
 */
function splitHostPort(rawHost: string): { host: string; port?: number; socketPath?: string } {
  if (rawHost.startsWith("/")) return { host: "localhost", socketPath: rawHost };
  const socketMatch = rawHost.match(/^([^:]*):(\/.+)$/u);
  if (socketMatch) return { host: socketMatch[1] || "localhost", socketPath: socketMatch[2] };
  const lastColon = rawHost.lastIndexOf(":");
  if (lastColon === -1) return { host: rawHost };
  const portPart = rawHost.slice(lastColon + 1);
  if (!/^\d+$/.test(portPart)) return { host: rawHost };
  return { host: rawHost.slice(0, lastColon), port: Number(portPart) };
}

/**
 * Converts one decoded connection entry (a plain JS object produced by
 * {@link literalValue}) into a {@link BitrixConnection}. Returns `undefined`
 * when the entry has neither a host nor a database, since it cannot be a
 * usable connection descriptor.
 */
function buildConnection(name: string, conf: unknown): BitrixConnection | undefined {
  if (typeof conf !== "object" || conf === null || Array.isArray(conf)) return undefined;
  const record = conf as Record<string, unknown>;
  const rawHost = record.host !== undefined && record.host !== null ? String(record.host) : undefined;
  const rawDatabase = record.database !== undefined && record.database !== null ? String(record.database) : undefined;
  if (rawHost === undefined && rawDatabase === undefined) return undefined;

  const { host, port, socketPath } = rawHost !== undefined ? splitHostPort(rawHost) : { host: "", port: undefined, socketPath: undefined };
  return {
    name,
    host,
    port,
    ...(socketPath ? { socketPath } : {}),
    database: rawDatabase ?? "",
    login: record.login !== undefined && record.login !== null ? String(record.login) : "",
    password: record.password !== undefined && record.password !== null ? String(record.password) : "",
    className: record.className !== undefined && record.className !== null ? String(record.className) : undefined
  };
}

function sectionValue(parsed: unknown, section: string): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[section];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  return (entry as Record<string, unknown>).value;
}

/**
 * Navigates the decoded `.settings.php` array to `connections.value` and
 * builds a {@link BitrixConnection} for each named entry.
 */
function extractConnections(parsed: unknown): BitrixConnection[] {
  const value = sectionValue(parsed, "connections");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];

  const connections: BitrixConnection[] = [];
  for (const [name, conf] of Object.entries(value as Record<string, unknown>)) {
    const connection = buildConnection(name, conf);
    if (connection) connections.push(connection);
  }
  return connections;
}

/** Reads `utf_mode.value`: true → UTF-8, false → legacy cp1251 site, undefined when not declared. */
function extractUtfMode(parsed: unknown): boolean | undefined {
  const value = sectionValue(parsed, "utf_mode");
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Extracts the first `'key' => '...'` (or `"key" => "..."`) string literal
 * for `key` anywhere in `source`, unescaping backslash-escaped quotes.
 */
function extractQuotedValue(source: string, key: string): string | undefined {
  const pattern = new RegExp(`["']${key}["']\\s*=>\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const match = source.match(pattern);
  return match?.[2].replace(/\\([\\"'])/g, "$1");
}

/**
 * Best-effort fallback used when the PHP AST parser throws on a
 * `.settings.php` file it cannot handle. Scans the raw source for the first
 * plausible `host`/`database`/`login`/`password`/`className` literals and,
 * if a host and database are both found, returns them as a single `default`
 * connection. Returns an empty array when no plausible connection is found.
 */
function parseConnectionsWithRegex(source: string): BitrixConnection[] {
  // Only look inside the connections section, so a cache/session `host` elsewhere is not picked up.
  const sectionStart = source.search(/["']connections["']\s*=>/u);
  if (sectionStart === -1) return [];
  const section = source.slice(sectionStart);
  const rawHost = extractQuotedValue(section, "host");
  const database = extractQuotedValue(section, "database");
  if (!rawHost || !database) return [];

  const login = extractQuotedValue(section, "login") ?? "";
  const password = extractQuotedValue(section, "password") ?? "";
  const className = extractQuotedValue(section, "className");
  const { host, port, socketPath } = splitHostPort(rawHost);

  return [
    {
      name: "default",
      host,
      port,
      ...(socketPath ? { socketPath } : {}),
      database,
      login,
      password,
      className
    }
  ];
}

interface ParsedSettingsFile {
  connections: BitrixConnection[];
  utfMode?: boolean;
}

/** Parses one settings file via the PHP AST, falling back to a scoped regex scan when the AST parse fails. */
function parseSettingsSource(source: string, filePath: string): ParsedSettingsFile {
  try {
    const ast = parsePhpToAst(source, filePath);
    const parsed = literalValue(findReturnExpression(ast), { uses: new Map() });
    return { connections: extractConnections(parsed), utfMode: extractUtfMode(parsed) };
  } catch {
    return { connections: parseConnectionsWithRegex(source) };
  }
}

/** Merges `.settings_extra.php` connections over `.settings.php` ones by name, as Bitrix does. */
function mergeConnections(base: BitrixConnection[], extra: BitrixConnection[]): BitrixConnection[] {
  const merged = new Map(base.map((connection) => [connection.name, connection]));
  for (const connection of extra) merged.set(connection.name, connection);
  return [...merged.values()];
}

/**
 * Reads and parses `bitrix/.settings.php` under the detected Bitrix project
 * root, returning every named DB connection it declares. Parses the file via
 * the shared PHP AST engine and falls back to a defensive regex scan if the
 * AST parse throws. Returns an empty connection list with an `error` message
 * when the Bitrix root is unknown or the settings file cannot be read.
 */
export async function readBitrixConnections(paths: RuntimePaths): Promise<{ connections: BitrixConnection[]; source: string; error?: string }> {
  if (!paths.bitrixRoot) {
    return { connections: [], source: "", error: "Bitrix root not detected; cannot locate bitrix/.settings.php." };
  }

  const settingsPath = path.join(paths.bitrixRoot, "bitrix", ".settings.php");
  const extraPath = path.join(paths.bitrixRoot, "bitrix", ".settings_extra.php");

  let source: string;
  try {
    source = await fs.readFile(settingsPath, "utf8");
  } catch {
    return { connections: [], source: settingsPath, error: `Settings file not found: ${settingsPath}` };
  }

  const base = parseSettingsSource(source, settingsPath);
  let extra: ParsedSettingsFile = { connections: [] };
  try {
    extra = parseSettingsSource(await fs.readFile(extraPath, "utf8"), extraPath);
  } catch {
    // .settings_extra.php is optional.
  }

  const utfMode = extra.utfMode ?? base.utfMode;
  const charset = utfMode === false ? "CP1251_GENERAL_CI" : utfMode === true ? "UTF8MB4_GENERAL_CI" : undefined;
  const connections = mergeConnections(base.connections, extra.connections).map((connection) => (charset ? { ...connection, charset } : connection));
  return { connections, source: settingsPath };
}

/**
 * Converts a {@link BitrixConnection} into a {@link RedactedConnection} safe
 * to return through an MCP tool result. The plaintext password is replaced
 * by a `hasPassword` flag and is never included in the output.
 */
export function redactConnection(conn: BitrixConnection, source: string): RedactedConnection {
  return {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    login: conn.login,
    hasPassword: conn.password.length > 0,
    className: conn.className,
    ...(conn.socketPath ? { socketPath: conn.socketPath } : {}),
    source
  };
}

/**
 * Reads all connections from `bitrix/.settings.php` and resolves the one
 * matching `name` (case-insensitive). When `name` is left at its default
 * value of `"default"` and no connection is literally named `default`, falls
 * back to the first declared connection. Returns `undefined` when no
 * connection matches and none can be used as a fallback.
 */
export async function resolveConnection(paths: RuntimePaths, name = "default"): Promise<BitrixConnection | undefined> {
  const { connections } = await readBitrixConnections(paths);
  if (connections.length === 0) return undefined;

  const normalized = name.toLowerCase();
  const exact = connections.find((connection) => connection.name.toLowerCase() === normalized);
  if (exact) return exact;

  return normalized === "default" ? connections[0] : undefined;
}

/**
 * Swaps in dedicated read-only credentials from `BITRIX_MCP_DB_READONLY_USER`
 * / `BITRIX_MCP_DB_READONLY_PASSWORD` when set, so `bitrix_db_query` and
 * `bitrix_db_schema` can run under an account that only has SELECT.
 */
export function withReadOnlyCredentials(conn: BitrixConnection, env: NodeJS.ProcessEnv = process.env): BitrixConnection {
  const login = env.BITRIX_MCP_DB_READONLY_USER?.trim();
  if (!login) return conn;
  return { ...conn, login, password: env.BITRIX_MCP_DB_READONLY_PASSWORD ?? "" };
}
