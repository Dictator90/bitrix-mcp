/**
 * Shared type contracts for the live project database access feature.
 * Both the `.settings.php` credential parser and the mysql2 client depend on
 * these shapes; the MCP tools and worker tasks consume them.
 */

/**
 * A single Bitrix database connection resolved from `bitrix/.settings.php`.
 * Carries the plaintext password for internal use only; never expose it through
 * an MCP tool result — use {@link RedactedConnection} for that.
 */
export interface BitrixConnection {
  name: string;
  host: string;
  port?: number;
  database: string;
  login: string;
  password: string;
  className?: string;
}

/**
 * A connection descriptor safe to return through MCP tools: the password is
 * replaced by the `hasPassword` flag and `source` records where it was parsed.
 */
export interface RedactedConnection {
  name: string;
  host: string;
  port?: number;
  database: string;
  login: string;
  hasPassword: boolean;
  className?: string;
  source: string;
}

/**
 * Result of executing a SQL statement through the mysql2 client.
 */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  affectedRows?: number;
}

/**
 * A single column description within a table schema.
 */
export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  key?: string;
  default?: string | null;
  extra?: string;
}

/**
 * Schema description for one table.
 */
export interface SchemaTable {
  name: string;
  engine?: string;
  rows?: number;
  columns: SchemaColumn[];
}

/**
 * Result of a schema introspection request.
 */
export interface SchemaResult {
  database: string;
  tables: SchemaTable[];
  truncated: boolean;
}
