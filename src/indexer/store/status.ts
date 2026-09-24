import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../database.js";
import type { IndexFile, IndexKind, IndexManifest, IndexWarning } from "../../types.js";
import { rowToHlblockUsage, rowToIblockUsage, rowToModuleUsage, rowToOptionUsage, rowToOrmEntity, rowToOrmUsage, rowToSymbol } from "./rows.js";
import type { FileRow, HlblockUsageRow, IblockUsageRow, ModuleUsageRow, OptionUsageRow, OrmEntityRow, OrmUsageRow, SymbolRow } from "./rows.js";
import { ensureSqliteStore } from "./schema.js";
import { parseWarningMeta } from "./writer.js";

export async function hasIndexMetadata(dbFile: string, kind: IndexKind): Promise<boolean> {
  try {
    await fs.access(dbFile);
  } catch {
    return false;
  }

  const db = openDatabase(dbFile);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'index_meta'").get();
    if (!table) {
      return false;
    }
    const row = db.prepare("SELECT 1 FROM index_meta WHERE key = ? LIMIT 1").get(`index:${kind}`);
    return Boolean(row);
  } finally {
    db.close();
  }
}

export async function readIndexFromSqlite(dbFile: string, kind: IndexKind): Promise<IndexManifest | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const fileRows = db.prepare("SELECT id, root, path, relative_path, size, mtime_ms, language, indexed_at FROM files WHERE kind = ? ORDER BY relative_path").all(kind) as unknown as FileRow[];
    if (fileRows.length === 0) {
      return undefined;
    }
    const symbolSelect = db.prepare("SELECT kind, type, language, name, module, fully_qualified_name, namespace, class_name, visibility, is_static, is_abstract, is_final, return_type, extends_name, implements_json, traits_json, parameters_json, handler_class, handler_method, handler_function, event_name, agent_action, api, site_id, periodic, interval, file, line, line_end, signature, description, component_template, params_json FROM symbols WHERE file_id = ? ORDER BY id");
    const moduleUsageSelect = db.prepare("SELECT id, file_id, kind, root, module, call, file, relative_file, line, signature FROM module_usages WHERE file_id = ? ORDER BY id");
    const ormEntitySelect = db.prepare("SELECT id, kind, root, class_name, fully_qualified_name, namespace, parent_class, module, table_name, file, relative_file, line, fields_json, references_json, signature FROM orm_entities WHERE file_id = ? ORDER BY id");
    const ormUsageSelect = db.prepare("SELECT id, kind, root, entity, method, usage_kind, module, file, relative_file, line, signature FROM orm_usages WHERE file_id = ? ORDER BY id");
    const iblockUsageSelect = db.prepare("SELECT id, file_id, kind, root, iblock_id, api, file, relative_file, line, signature, context_type, context_name, component FROM iblock_usages WHERE file_id = ? ORDER BY id");
    const hlblockUsageSelect = db.prepare("SELECT id, file_id, kind, root, hlblock_id, api, file, relative_file, line, signature, context_type, context_name FROM hlblock_usages WHERE file_id = ? ORDER BY id");
    const optionUsageSelect = db.prepare("SELECT id, file_id, kind, root, module, name, operation, api, file, relative_file, line, signature, context_type, context_name FROM option_usages WHERE file_id = ? ORDER BY id");
    const files: IndexFile[] = fileRows.map((file) => ({
      path: file.path,
      relativePath: file.relative_path,
      kind,
      size: file.size,
      mtimeMs: file.mtime_ms,
      language: file.language,
      symbols: (symbolSelect.all(file.id) as unknown as SymbolRow[]).map(rowToSymbol),
      moduleUsages: (moduleUsageSelect.all(file.id) as unknown as ModuleUsageRow[]).map(rowToModuleUsage),
      ormEntities: (ormEntitySelect.all(file.id) as unknown as OrmEntityRow[]).map(rowToOrmEntity),
      ormUsages: (ormUsageSelect.all(file.id) as unknown as OrmUsageRow[]).map(rowToOrmUsage),
      iblockUsages: (iblockUsageSelect.all(file.id) as unknown as IblockUsageRow[]).map(rowToIblockUsage),
      hlblockUsages: (hlblockUsageSelect.all(file.id) as unknown as HlblockUsageRow[]).map(rowToHlblockUsage),
      optionUsages: (optionUsageSelect.all(file.id) as unknown as OptionUsageRow[]).map(rowToOptionUsage)
    }));
    const warningRow = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(`index:${kind}:warnings`) as { value: string } | undefined;
    return {
      version: 1,
      generatedAt: fileRows[0].indexed_at,
      root: fileRows[0].root,
      kind,
      files,
      warnings: warningRow ? parseWarningMeta(warningRow.value).diagnostics : []
    };
  } finally {
    db.close();
  }
}


/** A `GROUP BY` tally (e.g. files per scope, symbols per language). */
export interface StatusBreakdown {
  label: string;
  count: number;
}

export interface IndexStatus {
  dbFile: string;
  files: number;
  filesByKind: StatusBreakdown[];
  filesByLanguage: StatusBreakdown[];
  symbols: number;
  symbolsByLanguage: StatusBreakdown[];
  events: number;
  moduleUsages: number;
  hlblockUsages: number;
  optionUsages: number;
  documents: number;
  docChunks: number;
  phpParseFallbackFiles: number;
  relations: number;
  components: number;
  agents: number;
  mailEvents: number;
  ormEntities: number;
  iblockUsages: number;
  autoloadRecords: number;
  lastIndexedAt?: string;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

/** Run a `SELECT <col> AS label, COUNT(*) AS count ... GROUP BY` query into a breakdown list. */
function groupCounts(db: DatabaseSync, sql: string): StatusBreakdown[] {
  return (db.prepare(sql).all() as Array<{ label: string | null; count: number }>).map((row) => ({
    label: row.label ?? "unknown",
    count: Number(row.count)
  }));
}

function countPhpParseFallbackFiles(db: DatabaseSync): number {
  const rows = db.prepare("SELECT value FROM index_meta WHERE key LIKE 'index:%:warnings'").all() as Array<{ value: string }>;
  return rows.reduce((sum, row) => sum + parseWarningMeta(row.value).phpParseFallbackFiles, 0);
}

export async function readIndexWarnings(dbFile: string, kind?: IndexKind): Promise<IndexWarning[]> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = kind
      ? db.prepare("SELECT value FROM index_meta WHERE key = ?").all(`index:${kind}:warnings`) as Array<{ value: string }>
      : db.prepare("SELECT value FROM index_meta WHERE key LIKE 'index:%:warnings'").all() as Array<{ value: string }>;
    return rows.flatMap((row) => parseWarningMeta(row.value).diagnostics);
  } finally {
    db.close();
  }
}

export async function getIndexStatus(dbFile: string): Promise<IndexStatus> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const lastIndexedRow = db.prepare("SELECT MAX(updated_at) AS last_indexed_at FROM index_meta WHERE key LIKE 'index:%'").get() as { last_indexed_at: string | null };
    return {
      dbFile,
      files: countRows(db, "files"),
      filesByKind: groupCounts(db, "SELECT kind AS label, COUNT(*) AS count FROM files GROUP BY kind ORDER BY count DESC, label ASC"),
      filesByLanguage: groupCounts(db, "SELECT language AS label, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC, label ASC"),
      symbols: countRows(db, "symbols"),
      symbolsByLanguage: groupCounts(db, "SELECT language AS label, COUNT(*) AS count FROM symbols GROUP BY language ORDER BY count DESC, label ASC"),
      events: countRows(db, "events"),
      moduleUsages: countRows(db, "module_usages"),
      hlblockUsages: countRows(db, "hlblock_usages"),
      optionUsages: countRows(db, "option_usages"),
      documents: countRows(db, "docs"),
      docChunks: countRows(db, "doc_chunks"),
      phpParseFallbackFiles: countPhpParseFallbackFiles(db),
      relations: countRows(db, "bitrix_relations"),
      components: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'component'").get() as { count: number }).count),
      agents: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'agent'").get() as { count: number }).count),
      mailEvents: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'mail_event'").get() as { count: number }).count),
      ormEntities: countRows(db, "orm_entities"),
      iblockUsages: countRows(db, "iblock_usages"),
      autoloadRecords: countRows(db, "autoload_records"),
      lastIndexedAt: lastIndexedRow.last_indexed_at ?? undefined
    };
  } finally {
    db.close();
  }
}

export interface ProjectOverviewOptions {
  workspaceRoot: string;
  bitrixRoot?: string;
  sqlitePath: string;
  includeTopFiles?: boolean;
  includeModules?: boolean;
  includeComponents?: boolean;
  includeEvents?: boolean;
  includeOrm?: boolean;
  includeAgents?: boolean;
  includeMailEvents?: boolean;
  includeWarnings?: boolean;
  format?: "compact" | "full";
}

function topRows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export async function getProjectOverview(dbFile: string, options: ProjectOverviewOptions): Promise<Record<string, unknown>> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const indexes = Object.fromEntries((["project", "template", "bitrix", "install", "docs"] as IndexKind[]).map((kind) => {
      const row = db.prepare("SELECT value, updated_at FROM index_meta WHERE key = ?").get(`index:${kind}`) as { value: string; updated_at: string } | undefined;
      return [kind, row ? { present: true, updatedAt: row.updated_at, ...(options.format === "full" ? { metadata: JSON.parse(row.value) as unknown } : {}) } : {}];
    }));
    const summary = {
      files: countRows(db, "files"),
      symbols: countRows(db, "symbols"),
      events: countRows(db, "events"),
      relations: countRows(db, "bitrix_relations"),
      documents: countRows(db, "docs"),
      components: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'component'").get() as { count: number }).count),
      agents: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'agent'").get() as { count: number }).count),
      mailEvents: Number((db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE type = 'mail_event'").get() as { count: number }).count),
      ormEntities: countRows(db, "orm_entities"),
      moduleUsages: countRows(db, "module_usages"),
      iblockUsages: countRows(db, "iblock_usages"),
      hlblockUsages: countRows(db, "hlblock_usages"),
      options: countRows(db, "option_usages"),
      autoloadRecords: countRows(db, "autoload_records")
    };
    const hasIndex = (kind: IndexKind) => Boolean(db.prepare("SELECT 1 FROM index_meta WHERE key = ? LIMIT 1").get(`index:${kind}`));
    const warnings: string[] = [];
    if (!hasIndex("project")) warnings.push("project index missing");
    if (!hasIndex("template")) warnings.push("template index missing");
    if (!hasIndex("bitrix")) warnings.push("bitrix index missing");
    if (!hasIndex("docs")) warnings.push("docs index missing");
    if (summary.events === 0) warnings.push("no events found");
    if (summary.relations === 0) warnings.push("no relations found");
    if (!options.bitrixRoot) warnings.push("no Bitrix root found");

    const overview: Record<string, unknown> = {
      workspaceRoot: options.workspaceRoot,
      bitrixRoot: options.bitrixRoot,
      sqlitePath: options.sqlitePath,
      indexes,
      summary,
      modules: options.includeModules === false ? [] : topRows(db, "SELECT module, COUNT(*) AS usages FROM module_usages GROUP BY module ORDER BY usages DESC, module ASC LIMIT 25"),
      components: options.includeComponents === false ? [] : topRows(db, "SELECT name AS component, component_template AS template, COUNT(*) AS usages FROM symbols WHERE type = 'component' GROUP BY name, component_template ORDER BY usages DESC, name ASC LIMIT 25"),
      templates: [],
      events: options.includeEvents === false ? [] : topRows(db, "SELECT module, name AS eventName, handler_class AS handlerClass, handler_method AS handlerMethod, handler_function AS handlerFunction, file, line FROM events ORDER BY id DESC LIMIT 25"),
      agents: options.includeAgents === false ? [] : topRows(db, "SELECT name, module, periodic, interval, file, line FROM symbols WHERE type = 'agent' ORDER BY id DESC LIMIT 25"),
      ormEntities: options.includeOrm === false ? [] : topRows(db, "SELECT class_name AS className, table_name AS tableName, module, file, line FROM orm_entities ORDER BY id DESC LIMIT 25"),
      mailEvents: options.includeMailEvents === false ? [] : topRows(db, "SELECT event_name AS eventName, api, site_id AS siteId, file, line FROM symbols WHERE type = 'mail_event' ORDER BY id DESC LIMIT 25"),
      warnings: options.includeWarnings === false ? [] : warnings
    };
    if (options.includeTopFiles) {
      overview.topFiles = topRows(db, "SELECT relative_path AS file, kind, language FROM files ORDER BY indexed_at DESC, id DESC LIMIT 25");
    }
    return overview;
  } finally {
    db.close();
  }
}
