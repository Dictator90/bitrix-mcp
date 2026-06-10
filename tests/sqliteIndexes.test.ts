import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSqliteStore } from "../src/indexer/sqliteStore.js";
import { sqlitePath } from "../src/config/paths.js";

// Regression guard for the index-all "hang": readIndexFromSqlite issues a
// `WHERE file_id = ? ORDER BY id` query per file against each child table.
// Without an index on file_id these become full table scans, turning the
// post-index readback of a large project (12k+ files) into ~9 minutes.
const CHILD_TABLES = [
  "symbols",
  "module_usages",
  "orm_entities",
  "orm_usages",
  "iblock_usages",
  "hlblock_usages",
  "option_usages"
];

test("per-file child-table lookups use a file_id index instead of a full scan", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-fileid-index-"));
  const dbFile = sqlitePath(dataDir);
  await ensureSqliteStore(dbFile);

  const db = new DatabaseSync(dbFile);
  try {
    for (const table of CHILD_TABLES) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE file_id = ? ORDER BY id`)
        .all(1) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join(" | ");
      assert.match(
        detail,
        /USING (COVERING )?INDEX/i,
        `${table} per-file lookup must use a file_id index, got plan: ${detail}`
      );
      assert.ok(
        !new RegExp(`SCAN ${table}\\b`).test(detail),
        `${table} per-file lookup must not full-scan, got plan: ${detail}`
      );
    }
  } finally {
    db.close();
  }
});
