import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { readIndexFromSqlite } from "../src/indexer/sqliteStore.js";
import { sqlitePath } from "../src/config/paths.js";

async function makeProject(): Promise<{ root: string; dbFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-return-src-"));
  await fs.writeFile(path.join(root, "demo.php"), "<?php\nfunction demo_fn(): void {}\n", "utf8");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-return-db-"));
  return { root, dbFile: sqlitePath(dataDir) };
}

test("buildIndex returns freshly parsed symbols in its manifest", async () => {
  const { root, dbFile } = await makeProject();
  const manifest = await buildIndex({ root, kind: "project", dbFile, force: true });
  assert.ok(
    manifest.files.some((file) => file.symbols.some((symbol) => symbol.name === "demo_fn")),
    "first run should return the parsed symbol in the manifest"
  );
});

test("buildIndex returns the in-memory manifest without rehydrating skipped files from SQLite", async () => {
  const { root, dbFile } = await makeProject();

  // First run parses and persists the file.
  await buildIndex({ root, kind: "project", dbFile, force: true });

  // Second run with no changes: the file is unchanged, so it is skipped (not re-parsed).
  const second = await buildIndex({ root, kind: "project", dbFile });
  const skipped = second.files.find((file) => file.relativePath === "demo.php");
  assert.ok(skipped, "skipped file must still be present in the returned manifest");
  assert.equal(
    skipped!.symbols.length,
    0,
    "a skipped file should not carry rehydrated symbols in the returned manifest (no full DB readback)"
  );

  // The symbols are not lost: they remain persisted in SQLite.
  const persisted = await readIndexFromSqlite(dbFile, "project");
  assert.ok(
    persisted?.files.some((file) => file.symbols.some((symbol) => symbol.name === "demo_fn")),
    "SQLite must still hold the persisted symbols for the unchanged file"
  );
});
