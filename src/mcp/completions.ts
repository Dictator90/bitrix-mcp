import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../indexer/database.js";

/**
 * Small, bounded read-only lookups for MCP argument completion. Each runs on
 * the main thread, so every query is a prefix range on a NOCASE index (or a
 * short LIMIT) and any failure (missing DB, old schema) yields no suggestions.
 */
export const MAX_COMPLETIONS = 50;

/** Upper bound for a case-insensitive prefix range scan on a NOCASE index. */
function upper(prefix: string): string {
  return `${prefix}￿`;
}

function withReadOnlyDb(dbFile: string, read: (db: DatabaseSync) => string[]): string[] {
  if (!fs.existsSync(dbFile)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(dbFile, { readOnly: true });
    return read(db);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    if (value && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, MAX_COMPLETIONS);
}

function column(rows: unknown[]): string[] {
  return rows.map((row) => String((row as { value: unknown }).value));
}

/** Module ids seen in module includes (graph edges) and event registrations. */
export function completeModules(dbFile: string, prefix: string): string[] {
  const value = prefix.trim();
  return withReadOnlyDb(dbFile, (db) => uniqueSorted([
    ...column(db.prepare(`
      SELECT DISTINCT target_name AS value FROM bitrix_relations
      WHERE target_type = 'module' AND target_name >= ? COLLATE NOCASE AND target_name < ? COLLATE NOCASE
      LIMIT ?
    `).all(value, upper(value), MAX_COMPLETIONS)),
    ...column(db.prepare(`
      SELECT DISTINCT module AS value FROM events
      WHERE module LIKE ? ESCAPE '\\'
      LIMIT ?
    `).all(`${value.replace(/[\\%_]/g, "\\$&")}%`, MAX_COMPLETIONS))
  ]));
}

/** Event names, optionally within one module. */
export function completeEvents(dbFile: string, prefix: string, module?: string): string[] {
  const value = prefix.trim();
  return withReadOnlyDb(dbFile, (db) => {
    const moduleFilter = module ? " AND module = ?" : "";
    const params: Array<string | number> = [value, upper(value), ...(module ? [module] : []), MAX_COMPLETIONS];
    return uniqueSorted(column(db.prepare(`
      SELECT DISTINCT name AS value FROM events
      WHERE name >= ? COLLATE NOCASE AND name < ? COLLATE NOCASE${moduleFilter}
      ORDER BY name COLLATE NOCASE
      LIMIT ?
    `).all(...params)));
  });
}

/** Component names used by IncludeComponent calls (graph edges). */
export function completeComponents(dbFile: string, prefix: string): string[] {
  const value = prefix.trim();
  return withReadOnlyDb(dbFile, (db) => uniqueSorted(column(db.prepare(`
    SELECT DISTINCT target_name AS value FROM bitrix_relations
    WHERE target_type = 'component' AND target_name >= ? COLLATE NOCASE AND target_name < ? COLLATE NOCASE
    ORDER BY target_name COLLATE NOCASE
    LIMIT ?
  `).all(value, upper(value), MAX_COMPLETIONS))));
}

/** Symbol or class names; needs at least two characters to stay selective. */
export function completeSymbols(dbFile: string, prefix: string): string[] {
  const value = prefix.trim();
  if (value.length < 2) return [];
  return withReadOnlyDb(dbFile, (db) => uniqueSorted([
    ...column(db.prepare(`
      SELECT DISTINCT class_name AS value FROM symbols
      WHERE class_name >= ? COLLATE NOCASE AND class_name < ? COLLATE NOCASE
      LIMIT ?
    `).all(value, upper(value), MAX_COMPLETIONS)),
    ...column(db.prepare(`
      SELECT DISTINCT name AS value FROM symbols
      WHERE name >= ? COLLATE NOCASE AND name < ? COLLATE NOCASE
      LIMIT ?
    `).all(value, upper(value), MAX_COMPLETIONS))
  ]));
}

const COMMON_BASE_REFS = ["HEAD~1", "HEAD", "main", "master", "origin/main", "origin/master", "develop"];

/** Common git base refs (no git call: completion must stay instant). */
export function completeBaseRefs(prefix: string): string[] {
  const value = prefix.trim().toLowerCase();
  return COMMON_BASE_REFS.filter((ref) => ref.toLowerCase().startsWith(value));
}
