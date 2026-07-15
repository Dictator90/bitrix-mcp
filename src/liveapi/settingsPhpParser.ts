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
 * Splits a Bitrix `host` value on its last `:` when the trailing segment is
 * purely numeric, treating it as a port. Sockets and hosts without a port
 * are returned unchanged.
 */
function splitHostPort(rawHost: string): { host: string; port?: number } {
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

  const { host, port } = rawHost !== undefined ? splitHostPort(rawHost) : { host: "", port: undefined };
  return {
    name,
    host,
    port,
    database: rawDatabase ?? "",
    login: record.login !== undefined && record.login !== null ? String(record.login) : "",
    password: record.password !== undefined && record.password !== null ? String(record.password) : "",
    className: record.className !== undefined && record.className !== null ? String(record.className) : undefined
  };
}

/**
 * Navigates the decoded `.settings.php` array to `connections.value` and
 * builds a {@link BitrixConnection} for each named entry.
 */
function extractConnections(parsed: unknown): BitrixConnection[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const connectionsSection = (parsed as Record<string, unknown>).connections;
  if (typeof connectionsSection !== "object" || connectionsSection === null || Array.isArray(connectionsSection)) return [];
  const value = (connectionsSection as Record<string, unknown>).value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];

  const connections: BitrixConnection[] = [];
  for (const [name, conf] of Object.entries(value as Record<string, unknown>)) {
    const connection = buildConnection(name, conf);
    if (connection) connections.push(connection);
  }
  return connections;
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
  const rawHost = extractQuotedValue(source, "host");
  const database = extractQuotedValue(source, "database");
  if (!rawHost || !database) return [];

  const login = extractQuotedValue(source, "login") ?? "";
  const password = extractQuotedValue(source, "password") ?? "";
  const className = extractQuotedValue(source, "className");
  const { host, port } = splitHostPort(rawHost);

  return [
    {
      name: "default",
      host,
      port,
      database,
      login,
      password,
      className
    }
  ];
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

  let source: string;
  try {
    source = await fs.readFile(settingsPath, "utf8");
  } catch {
    return { connections: [], source: settingsPath, error: `Settings file not found: ${settingsPath}` };
  }

  try {
    const ast = parsePhpToAst(source, settingsPath);
    const expr = findReturnExpression(ast);
    const parsed = literalValue(expr, { uses: new Map() });
    return { connections: extractConnections(parsed), source: settingsPath };
  } catch {
    return { connections: parseConnectionsWithRegex(source), source: settingsPath };
  }
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
