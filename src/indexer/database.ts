import { DatabaseSync } from "node:sqlite";

/** How long a connection waits for another writer's lock before failing with "database is locked". */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens the index database with the connection settings every caller needs:
 * a busy timeout (so reads and writes wait for a concurrent indexer instead of
 * failing immediately) and `synchronous = NORMAL`, which is safe with WAL.
 */
export function openDatabase(dbFile: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const db = options.readOnly ? new DatabaseSync(dbFile, { readOnly: true }) : new DatabaseSync(dbFile);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (!options.readOnly) db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}
