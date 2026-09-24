import fs from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "../database.js";
import { possibleComponentTemplateRelativePaths } from "../template.js";
import type { BitrixRelationRecord, IndexFile, IndexKind, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SearchResult, SymbolRecord, AutoloadRecord, AutoloadRecordType } from "../../types.js";
import { fileLookupClause, normalizeSlashes, normalizedFileLookupCandidates, nullable, relationMetadataJson, rowToBitrixRelation, rowToHlblockUsage, rowToIblockUsage, rowToModuleUsage, rowToOptionUsage, rowToOrmEntity, rowToOrmUsage, rowToSymbol } from "./rows.js";
import type { BitrixRelationRow, FileRow, HlblockUsageRow, IblockUsageRow, ModuleUsageRow, OptionUsageRow, OrmEntityRow, OrmUsageRow, SymbolRow } from "./rows.js";
import { ensureSqliteStore } from "./schema.js";
import { CLASS_NODE_TYPE, INHERITANCE_RELATION_TYPES, isCaseInsensitiveNodeType, normalizeStoredRelation, phpNameKey, storedGraphNodeTypes } from "./relations.js";
import type { AgentSearchQuery, AutoloadSearchQuery, BitrixRelationSearchQuery, ComponentContextQuery, ComponentContextResult, ComponentSearchQuery, HlblockUsageSearchQuery, IblockUsageSearchQuery, InheritanceSearchQuery, MailEventSearchQuery, MailEventSearchResult, ModuleUsageSearchQuery, OptionSearchQuery, OrmEntityMapQuery, OrmSearchQuery, OrmUsageSearchQuery, SymbolContextSearchQuery, WriteBitrixRelationsOptions } from "./types.js";


function rowToAutoloadRecord(row: { id: number; type: string; namespace_prefix: string | null; paths_json: string; file: string | null; package_name: string | null; version_constraint: string | null; source_file: string; root: string; dev: number; metadata_json: string | null }): AutoloadRecord {
  return {
    id: row.id,
    type: row.type as AutoloadRecordType,
    namespace: row.namespace_prefix ?? undefined,
    paths: JSON.parse(row.paths_json) as string[],
    file: row.file ?? undefined,
    package: row.package_name ?? undefined,
    version: row.version_constraint ?? undefined,
    sourceFile: row.source_file,
    root: row.root,
    dev: Boolean(row.dev),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined
  };
}

export async function writeAutoloadRecords(dbFile: string, records: AutoloadRecord[], relations: BitrixRelationRecord[]): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const now = new Date().toISOString();
    const insertRecord = db.prepare(`
      INSERT INTO autoload_records (type, namespace_prefix, paths_json, file, package_name, version_constraint, source_file, root, dev, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT INTO bitrix_relations (source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const setMeta = db.prepare("INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("DELETE FROM autoload_records").run();
      db.prepare("DELETE FROM bitrix_relations WHERE kind = 'autoload'").run();
      for (const record of records) {
        insertRecord.run(record.type, nullable(record.namespace), JSON.stringify(record.paths ?? []), nullable(record.file), nullable(record.package), nullable(record.version), record.sourceFile, record.root, record.dev ? 1 : 0, record.metadata === undefined ? null : JSON.stringify(record.metadata));
      }
      for (const relation of relations) {
        insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, normalizeSlashes(relation.file), relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
      }
      setMeta.run("index:autoload", JSON.stringify({ records: records.length }), now);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function searchAutoloadRecords(dbFile: string, query: AutoloadSearchQuery): Promise<AutoloadRecord[] | undefined> {
  try { await fs.access(dbFile); } catch { return undefined; }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (query.type !== undefined) { filters.push("type = ?"); params.push(query.type); }
    if (query.namespace !== undefined) { filters.push("namespace_prefix = ?"); params.push(query.namespace); }
    if (query.package !== undefined) { filters.push("package_name = ?"); params.push(query.package); }
    if (query.query !== undefined && query.query.trim()) {
      const like = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      filters.push("(coalesce(namespace_prefix, '') LIKE ? ESCAPE '\\' OR paths_json LIKE ? ESCAPE '\\' OR coalesce(file, '') LIKE ? ESCAPE '\\' OR coalesce(package_name, '') LIKE ? ESCAPE '\\' OR source_file LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, type, namespace_prefix, paths_json, file, package_name, version_constraint, source_file, root, dev, metadata_json
      FROM autoload_records
      ${whereClause}
      ORDER BY CASE type WHEN 'psr-4' THEN 0 WHEN 'files' THEN 1 WHEN 'classmap' THEN 2 WHEN 'dependency' THEN 3 WHEN 'dev_dependency' THEN 4 ELSE 5 END, id ASC
      LIMIT ?
    `).all(...params) as unknown as Array<{ id: number; type: string; namespace_prefix: string | null; paths_json: string; file: string | null; package_name: string | null; version_constraint: string | null; source_file: string; root: string; dev: number; metadata_json: string | null }>;
    return rows.map(rowToAutoloadRecord);
  } finally {
    db.close();
  }
}

export async function writeBitrixRelations(dbFile: string, relations: BitrixRelationRecord[], options: WriteBitrixRelationsOptions = {}): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const insertRelation = db.prepare(`
      INSERT INTO bitrix_relations (source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (options.clearKind !== undefined) {
        db.prepare("DELETE FROM bitrix_relations WHERE kind = ?").run(options.clearKind);
      }
      if (options.clearFile !== undefined) {
        db.prepare("DELETE FROM bitrix_relations WHERE file = ?").run(options.clearFile);
      }
      for (const relation of relations) {
        insertRelation.run(
          relation.sourceType,
          relation.sourceName,
          relation.targetType,
          relation.targetName,
          relation.relationType,
          relation.file,
          relation.line,
          nullable(relation.module),
          nullable(relation.kind),
          nullable(relation.signature),
          relationMetadataJson(relation)
        );
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}


export async function searchMailEvents(dbFile: string, query: MailEventSearchQuery): Promise<MailEventSearchResult[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = ["s.type = 'mail_event'"];
    const params: Array<string | number> = [];

    if (query.query !== undefined && query.query.trim()) {
      const like = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      filters.push("(s.name LIKE ? ESCAPE '\\' OR coalesce(s.event_name, '') LIKE ? ESCAPE '\\' OR coalesce(s.api, '') LIKE ? ESCAPE '\\' OR coalesce(s.site_id, '') LIKE ? ESCAPE '\\' OR coalesce(s.signature, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    if (query.eventName !== undefined) {
      filters.push("s.event_name = ?");
      params.push(query.eventName);
    }
    if (query.api !== undefined) {
      filters.push("s.api = ?");
      params.push(query.api);
    }
    if (query.file !== undefined) {
      const fileCandidates = normalizedFileLookupCandidates(query.file);
      filters.push(fileLookupClause(["s.file", "f.relative_path"], fileCandidates.length));
      params.push(...fileCandidates, ...fileCandidates);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const rows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE ${filters.join(" AND ")}
      ORDER BY s.id DESC
      LIMIT ?
    `).all(...params) as unknown as SymbolRow[];
    const mailEvents = rows.map(rowToSymbol) as MailEventSearchResult[];

    if (query.includeHandlers) {
      const handlers = db.prepare(`
        SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
               s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.type = 'event' AND s.module = 'main' AND s.event_name IN ('OnBeforeEventSend', 'OnBeforeEventAdd')
        ORDER BY s.id DESC
      `).all() as unknown as SymbolRow[];
      const handlerSymbols = handlers.map(rowToSymbol);
      for (const mailEvent of mailEvents) {
        mailEvent.handlers = handlerSymbols.filter((handler) => !mailEvent.kind || handler.kind === mailEvent.kind);
      }
    }

    return mailEvents;
  } finally {
    db.close();
  }
}

export interface CallSiteSearchQuery {
  /** `Class::method`, `$var->method`, or a bare method name. */
  query: string;
  kind?: IndexKind | IndexKind[];
  limit?: number;
}

/**
 * Finds indexed call sites (static and instance method calls) by callee name,
 * case-insensitively: exact `Class::method` matches first, then calls whose
 * method name matches a bare `method` query, then prefix matches.
 */
export async function searchCallSites(dbFile: string, query: CallSiteSearchQuery): Promise<Array<SearchResult<SymbolRecord>>> {
  const term = query.query.trim();
  if (!term) return [];
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
  const kindFilter = kinds.length ? ` AND c.kind IN (${kinds.map(() => "?").join(", ")})` : "";
  const bareMethod = !term.includes("::") && !term.includes("->");
  const escaped = term.replace(/[\\%_]/gu, "\\$&");
  const db = openDatabase(dbFile, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT c.kind, c.type, c.name, c.class_name, c.module, c.line, c.signature, f.path AS file, f.relative_path AS relative_file, f.language,
             CASE WHEN c.name = ? THEN 3 WHEN ? AND (c.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\') THEN 2 ELSE 1 END AS rank
      FROM call_sites c
      JOIN files f ON f.id = c.file_id
      WHERE (c.name = ? OR (? AND (c.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')) OR c.name LIKE ? ESCAPE '\\')${kindFilter}
      ORDER BY rank DESC, f.relative_path, c.line
      LIMIT ?
    `).all(
      term, bareMethod ? 1 : 0, `%::${escaped}`, `%->${escaped}`,
      term, bareMethod ? 1 : 0, `%::${escaped}`, `%->${escaped}`, `${escaped}%`,
      ...kinds, query.limit ?? 20
    ) as Array<{ kind: IndexKind; type: SymbolRecord["type"]; name: string; class_name: string | null; module: string | null; line: number; signature: string | null; file: string; relative_file: string; language: string; rank: number }>;
    return rows.map((row) => ({
      score: row.rank === 3 ? 1 : row.rank === 2 ? 0.9 : 0.8,
      item: {
        kind: row.kind,
        type: row.type,
        language: row.language,
        name: row.name,
        className: row.class_name ?? undefined,
        module: row.module ?? undefined,
        file: row.file,
        relativeFile: row.relative_file,
        line: row.line,
        signature: row.signature ?? undefined
      }
    }));
  } finally {
    db.close();
  }
}

export async function searchSymbolsForContext(dbFile: string, query: SymbolContextSearchQuery): Promise<SymbolRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const normalizedName = query.name.trim().toLowerCase();
    if (!normalizedName) return [];

    const filters: string[] = [
      "(lower(s.name) = ? OR lower(coalesce(s.class_name, '') || '::' || s.name) = ? OR lower(coalesce(s.event_name, '')) = ?)"
    ];
    const params: Array<string | number> = [normalizedName, normalizedName, normalizedName];

    if (query.type !== undefined) {
      filters.push("s.type = ?");
      params.push(query.type);
    }
    if (query.file !== undefined) {
      const fileCandidates = normalizedFileLookupCandidates(query.file);
      filters.push(fileLookupClause(["s.file", "f.relative_path"], fileCandidates.length));
      params.push(...fileCandidates, ...fileCandidates);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 20)));
    const rows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.fully_qualified_name, s.namespace, s.class_name, s.visibility, s.is_static, s.is_abstract, s.is_final, s.return_type, s.extends_name, s.implements_json, s.traits_json, s.parameters_json, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE ${filters.join(" AND ")}
      ORDER BY
        CASE WHEN s.kind IN ('project', 'template') THEN 0 ELSE 1 END,
        CASE WHEN lower(s.name) = ? THEN 0 ELSE 1 END,
        s.line ASC,
        s.id ASC
      LIMIT ?
    `).all(...params, normalizedName, limit) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  } finally {
    db.close();
  }
}

export async function searchAgents(dbFile: string, query: AgentSearchQuery): Promise<SymbolRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = ["s.type = 'agent'"];
    const params: Array<string | number> = [];

    if (query.query !== undefined && query.query.trim()) {
      const like = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      filters.push("(s.name LIKE ? ESCAPE '\\' OR coalesce(s.module, '') LIKE ? ESCAPE '\\' OR coalesce(s.signature, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (query.module !== undefined) {
      filters.push("s.module = ?");
      params.push(query.module);
    }
    if (query.file !== undefined) {
      filters.push("(s.file = ? OR f.relative_path = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const rows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE ${filters.join(" AND ")}
      ORDER BY s.id DESC
      LIMIT ?
    `).all(...params) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  } finally {
    db.close();
  }
}

export async function searchModuleUsages(dbFile: string, query: ModuleUsageSearchQuery): Promise<ModuleUsageRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];

    if (query.module !== undefined) {
      filters.push("module = ?");
      params.push(query.module);
    }
    if (query.call !== undefined) {
      filters.push("call = ?");
      params.push(query.call);
    }
    if (query.file !== undefined) {
      filters.push("(file = ? OR relative_file = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, file_id, kind, root, module, call, file, relative_file, line, signature
      FROM module_usages
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as ModuleUsageRow[];
    return rows.map(rowToModuleUsage);
  } finally {
    db.close();
  }
}


const RELATION_COLUMNS = "id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json";
const DEFAULT_INHERITANCE_DEPTH = 5;
const MAX_INHERITANCE_DEPTH = 10;
/** Upper bound of relation rows read per transitive inheritance level (keeps hub parents bounded). */
const MAX_INHERITANCE_ROWS_PER_LEVEL = 5000;
const SQL_IN_CHUNK = 400;

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function inheritanceKindRank(kind: string | undefined): number {
  return kind === "project" || kind === "template" ? 0 : 1;
}

/**
 * Finds classes that extend / implement / use the target.
 *
 * Matching: a target containing a backslash is matched as an exact fully qualified name; a short
 * name matches only the last namespace segment exactly (`Base` matches `Foo\Base`, never
 * `Foo\MyBase`). Comparisons are case-insensitive and ignore a leading backslash, as in PHP.
 *
 * With `transitive: true` descendants are followed breadth-first (subclasses of matching classes,
 * which inherit their parents' interfaces and traits) up to `maxDepth` levels; the walk is
 * cycle-safe and every level is bounded. Each transitive result carries `metadata.depth` and
 * `metadata.via` (the ancestor it was reached through). `kind` / `module` filter the returned rows
 * only, so a project class extending a core class that extends the target is still found.
 */
export async function searchInheritanceRelations(dbFile: string, query: InheritanceSearchQuery): Promise<BitrixRelationRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const normalizedTarget = phpNameKey(query.target);
    if (!normalizedTarget) return [];
    const exactTarget = normalizedTarget.includes("\\");
    const requestedRelations = query.relation && query.relation !== "any" ? [query.relation] : [...INHERITANCE_RELATION_TYPES];
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    const sourceTypes = storedGraphNodeTypes(CLASS_NODE_TYPE);
    const sourceTypeFilter = `source_type IN (${sourceTypes.map(() => "?").join(", ")})`;
    const targetExpr = "lower(ltrim(target_name, char(92)))";
    const firstLevelTargetFilter = exactTarget ? `${targetExpr} = ?` : `(${targetExpr} = ? OR substr(${targetExpr}, -?) = ?)`;
    const firstLevelTargetParams: Array<string | number> = exactTarget ? [normalizedTarget] : [normalizedTarget, normalizedTarget.length + 1, `\\${normalizedTarget}`];

    if (query.transitive !== true) {
      const filters = [sourceTypeFilter, `relation_type IN (${requestedRelations.map(() => "?").join(", ")})`, firstLevelTargetFilter];
      const params: Array<string | number> = [...sourceTypes, ...requestedRelations, ...firstLevelTargetParams];
      if (kinds.length > 0) {
        filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
        params.push(...kinds);
      }
      if (query.module !== undefined) {
        filters.push("module = ?");
        params.push(query.module);
      }
      params.push(limit);
      const rows = db.prepare(`
        SELECT ${RELATION_COLUMNS}
        FROM bitrix_relations
        WHERE ${filters.join(" AND ")}
        ORDER BY CASE WHEN kind IN ('project', 'template') THEN 0 ELSE 1 END, source_name ASC, id ASC
        LIMIT ?
      `).all(...params) as unknown as BitrixRelationRow[];
      return rows.map((row) => normalizeStoredRelation(rowToBitrixRelation(row)));
    }

    const maxDepth = Math.max(1, Math.min(MAX_INHERITANCE_DEPTH, Math.floor(query.maxDepth ?? DEFAULT_INHERITANCE_DEPTH)));
    // Subclasses inherit interfaces and traits, so deeper levels also follow `extends`.
    const deeperRelations = [...new Set([...requestedRelations, "extends"])];
    const visited = new Set<string>([normalizedTarget]);
    const seenRows = new Set<number>();
    const results: BitrixRelationRecord[] = [];
    let frontier: string[] = [normalizedTarget];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const relations = depth === 1 ? requestedRelations : deeperRelations;
      const relationFilter = `relation_type IN (${relations.map(() => "?").join(", ")})`;
      const levelRows: BitrixRelationRow[] = [];
      const targetChunks: string[][] = depth === 1 ? [[]] : chunked(frontier, SQL_IN_CHUNK);
      for (const chunk of targetChunks) {
        const targetFilter = depth === 1 ? firstLevelTargetFilter : `${targetExpr} IN (${chunk.map(() => "?").join(", ")})`;
        const targetParams = depth === 1 ? firstLevelTargetParams : chunk;
        const rows = db.prepare(`
          SELECT ${RELATION_COLUMNS}
          FROM bitrix_relations
          WHERE ${sourceTypeFilter} AND ${relationFilter} AND ${targetFilter}
          ORDER BY id ASC
          LIMIT ?
        `).all(...sourceTypes, ...relations, ...targetParams, MAX_INHERITANCE_ROWS_PER_LEVEL - levelRows.length) as unknown as BitrixRelationRow[];
        levelRows.push(...rows);
        if (levelRows.length >= MAX_INHERITANCE_ROWS_PER_LEVEL) break;
      }

      const next: string[] = [];
      const levelResults: BitrixRelationRecord[] = [];
      for (const row of levelRows) {
        if (seenRows.has(row.id)) continue;
        seenRows.add(row.id);
        const relation = normalizeStoredRelation(rowToBitrixRelation(row));
        const matchesKind = kinds.length === 0 || (relation.kind !== undefined && (kinds as string[]).includes(relation.kind));
        const matchesModule = query.module === undefined || relation.module === query.module;
        if (matchesKind && matchesModule) {
          levelResults.push({ ...relation, metadata: { ...(relation.metadata ?? {}), depth, via: relation.targetName } });
        }
        const sourceKey = phpNameKey(relation.sourceName);
        if (!visited.has(sourceKey)) {
          visited.add(sourceKey);
          next.push(sourceKey);
        }
      }
      levelResults.sort((a, b) => inheritanceKindRank(a.kind) - inheritanceKindRank(b.kind) || a.sourceName.localeCompare(b.sourceName) || (a.id ?? 0) - (b.id ?? 0));
      for (const relation of levelResults) {
        results.push(relation);
        if (results.length >= limit) return results;
      }
      frontier = next;
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Exact-match relation lookup. `class` also matches the legacy class-like node types
 * (`parent_class`, `interface`, `trait`), and names of class/method/function/ORM entity nodes are
 * compared case-insensitively (a leading backslash is ignored), as PHP does.
 */
export async function searchBitrixRelations(dbFile: string, query: BitrixRelationSearchQuery): Promise<BitrixRelationRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    for (const [typeColumn, nameColumn, type, name] of [
      ["source_type", "source_name", query.sourceType, query.sourceName],
      ["target_type", "target_name", query.targetType, query.targetName]
    ] as const) {
      if (type !== undefined) {
        const types = storedGraphNodeTypes(type);
        filters.push(`${typeColumn} IN (${types.map(() => "?").join(", ")})`);
        params.push(...types);
      }
      if (name !== undefined) {
        if (type !== undefined && isCaseInsensitiveNodeType(type)) {
          const bare = name.trim().replace(/^\\+/u, "");
          filters.push(`(${nameColumn} = ? COLLATE NOCASE OR ${nameColumn} = ? COLLATE NOCASE)`);
          params.push(bare, `\\${bare}`);
        } else {
          filters.push(`${nameColumn} = ?`);
          params.push(name);
        }
      }
    }
    for (const [column, value] of [
      ["relation_type", query.relationType],
      ["module", query.module],
      ["kind", query.kind],
      ["file", query.file]
    ] as const) {
      if (value !== undefined) {
        filters.push(`${column} = ?`);
        params.push(value);
      }
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT ${RELATION_COLUMNS}
      FROM bitrix_relations
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as BitrixRelationRow[];
    return rows.map((row) => normalizeStoredRelation(rowToBitrixRelation(row)));
  } finally {
    db.close();
  }
}


export async function searchComponents(dbFile: string, query: ComponentSearchQuery): Promise<SymbolRecord[] | undefined> {
  try { await fs.access(dbFile); } catch { return undefined; }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = ["s.type = 'component'"];
    const params: Array<string | number> = [];
    if (query.query !== undefined && query.query.trim()) {
      const like = likeValue(query.query);
      filters.push("(s.name LIKE ? ESCAPE '\\' OR coalesce(s.component_template, '') LIKE ? ESCAPE '\\' OR coalesce(s.params_json, '') LIKE ? ESCAPE '\\' OR coalesce(s.signature, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (query.component !== undefined) { filters.push("s.name = ?"); params.push(query.component); }
    if (query.template !== undefined) { filters.push("s.component_template = ?"); params.push(query.template.trim() ? query.template : ".default"); }
    if (query.file !== undefined) { filters.push("(s.file = ? OR f.relative_path = ?)"); params.push(query.file, query.file); }
    const kinds = queryKinds(query.kind);
    if (kinds.length) { filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`); params.push(...kinds); }
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const rows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE ${filters.join(" AND ")}
      ORDER BY s.id DESC
      LIMIT ?
    `).all(...params) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  } finally { db.close(); }
}

function rowToIndexFile(row: FileRow): IndexFile {
  return { path: row.path, relativePath: row.relative_path, kind: row.kind as IndexKind, size: row.size, mtimeMs: row.mtime_ms, language: row.language, symbols: [] };
}

export async function getComponentContext(dbFile: string, query: ComponentContextQuery): Promise<ComponentContextResult | undefined> {
  try { await fs.access(dbFile); } catch { return undefined; }
  await ensureSqliteStore(dbFile);
  const template = query.template && query.template.trim() ? query.template : ".default";
  const calls = await searchComponents(dbFile, { component: query.component, template, file: query.callFile, limit: 500 }) ?? [];
  const db = openDatabase(dbFile);
  try {
    const possiblePaths = possibleComponentTemplateRelativePaths(query.component, template);
    const fileFilters: string[] = [];
    const fileParams: string[] = [];
    for (const candidate of possiblePaths) {
      if (candidate.includes("<site>")) {
        fileFilters.push("relative_path LIKE ? ESCAPE '\\'");
        fileParams.push(`${candidate.replace("<site>", "%")}/%`);
      } else {
        fileFilters.push("relative_path LIKE ? ESCAPE '\\'");
        fileParams.push(`${candidate}/%`);
      }
    }
    const files = fileFilters.length ? (db.prepare(`
      SELECT id, kind, root, path, relative_path, size, mtime_ms, language, indexed_at
      FROM files
      WHERE ${fileFilters.map((filter) => `(${filter})`).join(" OR ")}
      ORDER BY relative_path
      LIMIT 500
    `).all(...fileParams) as unknown as FileRow[]).map(rowToIndexFile) : [];
    const assets = query.includeAssets === false ? [] : files.filter((file) => /(?:^|\/)(?:script\.js|style\.css)$/u.test(file.relativePath));
    const templateFiles = query.includeFiles === false ? [] : files.filter((file) => !/(?:^|\/)(?:script\.js|style\.css)$/u.test(file.relativePath));
    const relationRows = db.prepare(`
      SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
      FROM bitrix_relations
      WHERE (source_type = 'component' AND source_name = ?) OR (target_type = 'component' AND target_name = ?) OR (source_type = 'file' AND target_type = 'component' AND target_name = ?)
      ORDER BY id DESC
      LIMIT 500
    `).all(query.component, query.component, query.component) as unknown as BitrixRelationRow[];
    const parameters = query.includeParams === false ? [] : calls.flatMap((call) => call.params ?? []);
    return { component: query.component, template, calls, templateFiles, assets, parameters, relations: relationRows.map(rowToBitrixRelation), possibleTemplatePaths: possiblePaths };
  } finally { db.close(); }
}

function queryKinds(kind: OrmSearchQuery["kind"] | OrmUsageSearchQuery["kind"] | undefined): string[] {
  return kind === undefined ? [] : Array.isArray(kind) ? kind : [kind];
}

function likeValue(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, "\\$&")}%`;
}

export async function searchIblockUsages(dbFile: string, query: IblockUsageSearchQuery): Promise<IblockUsageRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];

    if (query.query !== undefined && query.query.trim()) {
      const like = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      filters.push("(iblock_id LIKE ? ESCAPE '\\' OR api LIKE ? ESCAPE '\\' OR coalesce(signature, '') LIKE ? ESCAPE '\\' OR coalesce(context_name, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (query.iblockId !== undefined) {
      filters.push("iblock_id = ?");
      params.push(query.iblockId);
    }
    if (query.api !== undefined) {
      filters.push("api = ?");
      params.push(query.api);
    }
    if (query.file !== undefined) {
      filters.push("(file = ? OR relative_file = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, file_id, kind, root, iblock_id, api, file, relative_file, line, signature, context_type, context_name, component
      FROM iblock_usages
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as IblockUsageRow[];
    return rows.map(rowToIblockUsage);
  } finally {
    db.close();
  }
}

export async function searchHlblockUsages(dbFile: string, query: HlblockUsageSearchQuery): Promise<HlblockUsageRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];

    if (query.query !== undefined && query.query.trim()) {
      const like = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      filters.push("(hlblock_id LIKE ? ESCAPE '\\' OR api LIKE ? ESCAPE '\\' OR coalesce(signature, '') LIKE ? ESCAPE '\\' OR coalesce(context_name, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (query.hlblockId !== undefined) {
      filters.push("hlblock_id = ?");
      params.push(query.hlblockId);
    }
    if (query.api !== undefined) {
      filters.push("api = ?");
      params.push(query.api);
    }
    if (query.file !== undefined) {
      filters.push("(file = ? OR relative_file = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, file_id, kind, root, hlblock_id, api, file, relative_file, line, signature, context_type, context_name
      FROM hlblock_usages
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as HlblockUsageRow[];
    return rows.map(rowToHlblockUsage);
  } finally {
    db.close();
  }
}


export async function searchOptionUsages(dbFile: string, query: OptionSearchQuery): Promise<OptionUsageRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];

    if (query.query !== undefined && query.query.trim()) {
      const like = likeValue(query.query);
      filters.push("(module LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR api LIKE ? ESCAPE '\\' OR coalesce(signature, '') LIKE ? ESCAPE '\\' OR coalesce(context_name, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    if (query.module !== undefined) {
      filters.push("module = ?");
      params.push(query.module);
    }
    if (query.name !== undefined) {
      filters.push("name = ?");
      params.push(query.name);
    }
    if (query.operation !== undefined) {
      filters.push("operation = ?");
      params.push(query.operation);
    }
    if (query.api !== undefined) {
      filters.push("api = ?");
      params.push(query.api);
    }
    if (query.file !== undefined) {
      filters.push("(file = ? OR relative_file = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, file_id, kind, root, module, name, operation, api, file, relative_file, line, signature, context_type, context_name
      FROM option_usages
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as OptionUsageRow[];
    return rows.map(rowToOptionUsage);
  } finally {
    db.close();
  }
}

export async function searchOrmEntities(dbFile: string, query: OrmSearchQuery): Promise<OrmEntityRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (query.query !== undefined && query.query.trim()) {
      const like = likeValue(query.query);
      filters.push("(class_name LIKE ? ESCAPE '\\' OR fully_qualified_name LIKE ? ESCAPE '\\' OR coalesce(table_name, '') LIKE ? ESCAPE '\\' OR coalesce(module, '') LIKE ? ESCAPE '\\' OR fields_json LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    if (query.tableName !== undefined) { filters.push("table_name = ?"); params.push(query.tableName); }
    if (query.className !== undefined) { filters.push("(class_name = ? OR fully_qualified_name = ?)"); params.push(query.className, query.className); }
    if (query.module !== undefined) { filters.push("module = ?"); params.push(query.module); }
    const kinds = queryKinds(query.kind);
    if (kinds.length) { filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`); params.push(...kinds); }
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, kind, root, class_name, fully_qualified_name, namespace, parent_class, module, table_name, file, relative_file, line, fields_json, references_json, signature
      FROM orm_entities
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as OrmEntityRow[];
    return rows.map(rowToOrmEntity);
  } finally {
    db.close();
  }
}

export async function getOrmEntityMap(dbFile: string, query: OrmEntityMapQuery): Promise<OrmEntityRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (query.className !== undefined) { filters.push("(class_name = ? OR fully_qualified_name = ?)"); params.push(query.className, query.className); }
    if (query.tableName !== undefined) { filters.push("table_name = ?"); params.push(query.tableName); }
    if (query.file !== undefined) { filters.push("(file = ? OR relative_file = ?)"); params.push(query.file, query.file); }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, kind, root, class_name, fully_qualified_name, namespace, parent_class, module, table_name, file, relative_file, line, fields_json, references_json, signature
      FROM orm_entities
      ${whereClause}
      ORDER BY id DESC
      LIMIT 50
    `).all(...params) as unknown as OrmEntityRow[];
    return rows.map(rowToOrmEntity);
  } finally {
    db.close();
  }
}

export async function searchOrmUsages(dbFile: string, query: OrmUsageSearchQuery): Promise<OrmUsageRecord[] | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (query.query !== undefined && query.query.trim()) {
      const like = likeValue(query.query);
      filters.push("(entity LIKE ? ESCAPE '\\' OR method LIKE ? ESCAPE '\\' OR usage_kind LIKE ? ESCAPE '\\' OR coalesce(signature, '') LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (query.entity !== undefined) { filters.push("entity = ?"); params.push(query.entity); }
    if (query.method !== undefined) { filters.push("method = ?"); params.push(query.method); }
    if (query.file !== undefined) { filters.push("(file = ? OR relative_file = ?)"); params.push(query.file, query.file); }
    const kinds = queryKinds(query.kind);
    if (kinds.length) { filters.push(`kind IN (${kinds.map(() => "?").join(", ")})`); params.push(...kinds); }
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 20)));
    params.push(limit);
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, kind, root, entity, method, usage_kind, module, file, relative_file, line, signature
      FROM orm_usages
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as OrmUsageRow[];
    return rows.map(rowToOrmUsage);
  } finally {
    db.close();
  }
}

export async function clearBitrixRelationsByKind(dbFile: string, kind: string): Promise<number> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const result = db.prepare("DELETE FROM bitrix_relations WHERE kind = ?").run(kind);
    return Number(result.changes);
  } finally {
    db.close();
  }
}

export async function clearBitrixRelationsByFile(dbFile: string, file: string): Promise<number> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const result = db.prepare("DELETE FROM bitrix_relations WHERE file = ?").run(file);
    return Number(result.changes);
  } finally {
    db.close();
  }
}
