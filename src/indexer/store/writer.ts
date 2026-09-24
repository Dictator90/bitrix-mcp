import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../database.js";
import type { IndexFile, IndexKind, IndexManifest, IndexWarning, SymbolRecord } from "../../types.js";
import { agentRelationsForSymbol, componentRelationsForFile, componentRelationsForSymbol, eventRelationsForSymbol, inheritanceRelationsForSymbol, mailEventRelationsForSymbol, moduleUsageRelationsForFile } from "./relations.js";
import { nullable, relationFileForStorage, relationMetadataJson, rowToSymbol } from "./rows.js";
import type { SymbolRow } from "./rows.js";
import { PARSER_VERSION, ensureSqliteStore } from "./schema.js";
import type { ExistingIndexFile } from "./types.js";

export async function readExistingFilesByKind(dbFile: string, kind: IndexKind): Promise<ExistingIndexFile[]> {
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare("SELECT id, path, relative_path, size, mtime_ms FROM files WHERE kind = ?").all(kind) as Array<{ id: number; path: string; relative_path: string; size: number; mtime_ms: number }>;
    return rows.map((row) => ({ id: row.id, path: row.path, relativePath: row.relative_path, size: row.size, mtimeMs: row.mtime_ms }));
  } finally {
    db.close();
  }
}

export interface WriteIndexOptions {
  force?: boolean;
}

function warningMetaValue(warnings: IndexWarning[] | undefined): string {
  const diagnostics = warnings ?? [];
  return JSON.stringify({
    phpParseFallbackFiles: new Set(diagnostics.filter((warning) => warning.type === "php_parse_fallback").map((warning) => warning.file)).size,
    diagnostics
  });
}

export function parseWarningMeta(value: string): { phpParseFallbackFiles: number; diagnostics: IndexWarning[] } {
  try {
    const parsed = JSON.parse(value) as { phpParseFallbackFiles?: unknown; diagnostics?: unknown };
    return {
      phpParseFallbackFiles: typeof parsed.phpParseFallbackFiles === "number" ? parsed.phpParseFallbackFiles : 0,
      diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics.filter((entry): entry is IndexWarning => typeof entry === "object" && entry !== null && ((entry as { type?: unknown }).type === "php_parse_fallback" || (entry as { type?: unknown }).type === "file_error") && typeof (entry as { file?: unknown }).file === "string" && typeof (entry as { message?: unknown }).message === "string") : []
    };
  } catch {
    return { phpParseFallbackFiles: 0, diagnostics: [] };
  }
}

/** Existing row state used to decide whether a file must be re-parsed. */
interface StoredFileState {
  id: number;
  path: string;
  relative_path: string;
  size: number;
  mtime_ms: number;
  parser_version: number;
}

function prepareWriteStatements(db: DatabaseSync) {
  const upsertFile = db.prepare(`
    INSERT INTO files (kind, root, path, relative_path, size, mtime_ms, language, indexed_at, parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, path) DO UPDATE SET
      root = excluded.root,
      relative_path = excluded.relative_path,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      language = excluded.language,
      indexed_at = excluded.indexed_at,
      parser_version = excluded.parser_version
    RETURNING id
  `);
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (file_id, kind, root, type, language, name, module, fully_qualified_name, namespace, class_name, visibility, is_static, is_abstract, is_final, return_type, extends_name, implements_json, traits_json, parameters_json, handler_class, handler_method, handler_function, event_name, agent_action, api, site_id, periodic, interval, file, line, line_end, signature, description, component_template, params_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (symbol_id, file_id, kind, root, module, name, handler_class, handler_method, handler_function, file, line, signature, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertModuleUsage = db.prepare(`
    INSERT INTO module_usages (file_id, kind, root, module, call, file, relative_file, line, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrmEntity = db.prepare(`
    INSERT INTO orm_entities (file_id, kind, root, class_name, fully_qualified_name, namespace, parent_class, module, table_name, file, relative_file, line, fields_json, references_json, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrmUsage = db.prepare(`
    INSERT INTO orm_usages (file_id, kind, root, entity, method, usage_kind, module, file, relative_file, line, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIblockUsage = db.prepare(`
    INSERT INTO iblock_usages (file_id, kind, root, iblock_id, api, file, relative_file, line, signature, context_type, context_name, component)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHlblockUsage = db.prepare(`
    INSERT INTO hlblock_usages (file_id, kind, root, hlblock_id, api, file, relative_file, line, signature, context_type, context_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOptionUsage = db.prepare(`
    INSERT INTO option_usages (file_id, kind, root, module, name, operation, api, file, relative_file, line, signature, context_type, context_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSymbolFts = db.prepare(`
    INSERT INTO symbols_fts (rowid, name, type, module, class_name, signature, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEventFts = db.prepare(`
    INSERT INTO events_fts (rowid, name, module, handler_class, handler_method, handler_function, signature, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRelation = db.prepare(`
    INSERT INTO bitrix_relations (source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const setMeta = db.prepare(`
    INSERT INTO index_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const deleteSymbolsFtsForFile = db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)");
  const deleteEventsFtsForFile = db.prepare("DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE file_id = ?)");
  const deleteEventsForFile = db.prepare("DELETE FROM events WHERE file_id = ?");
  const deleteModuleUsagesForFile = db.prepare("DELETE FROM module_usages WHERE file_id = ?");
  const deleteOrmEntitiesForFile = db.prepare("DELETE FROM orm_entities WHERE file_id = ?");
  const deleteOrmUsagesForFile = db.prepare("DELETE FROM orm_usages WHERE file_id = ?");
  const deleteIblockUsagesForFile = db.prepare("DELETE FROM iblock_usages WHERE file_id = ?");
  const deleteHlblockUsagesForFile = db.prepare("DELETE FROM hlblock_usages WHERE file_id = ?");
  const deleteOptionUsagesForFile = db.prepare("DELETE FROM option_usages WHERE file_id = ?");
  const deleteSymbolsForFile = db.prepare("DELETE FROM symbols WHERE file_id = ?");
  const deleteRelationsForFile = db.prepare("DELETE FROM bitrix_relations WHERE file = ? OR file = ?");
  const deleteFileById = db.prepare("DELETE FROM files WHERE id = ?");
  const insertCallSite = db.prepare(`
    INSERT INTO call_sites (file_id, kind, type, name, class_name, module, line, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteCallSitesForFile = db.prepare("DELETE FROM call_sites WHERE file_id = ?");
  return { upsertFile, insertSymbol, insertEvent, insertModuleUsage, insertOrmEntity, insertOrmUsage, insertIblockUsage, insertHlblockUsage, insertOptionUsage, insertSymbolFts, insertEventFts, insertRelation, setMeta, deleteSymbolsFtsForFile, deleteEventsFtsForFile, deleteEventsForFile, deleteModuleUsagesForFile, deleteOrmEntitiesForFile, deleteOrmUsagesForFile, deleteIblockUsagesForFile, deleteHlblockUsagesForFile, deleteOptionUsagesForFile, deleteSymbolsForFile, deleteRelationsForFile, deleteFileById, insertCallSite, deleteCallSitesForFile };
}

type WriteStatements = ReturnType<typeof prepareWriteStatements>;

const CALL_SITE_SIGNATURE_MAX_CHARS = 160;

function isCallSite(symbol: SymbolRecord): boolean {
  return symbol.type === "static_call" || symbol.type === "method_call";
}

function truncateSignature(signature: string | undefined): string | undefined {
  if (signature === undefined) return undefined;
  const compact = signature.replace(/\s+/gu, " ").trim();
  return compact.length > CALL_SITE_SIGNATURE_MAX_CHARS ? `${compact.slice(0, CALL_SITE_SIGNATURE_MAX_CHARS)}…` : compact;
}

function isUnderRoot(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Removes every row derived from one indexed file, including the file row itself. */
function deleteIndexedFile(st: WriteStatements, file: StoredFileState): void {
  st.deleteSymbolsFtsForFile.run(file.id);
  st.deleteEventsFtsForFile.run(file.id);
  st.deleteRelationsForFile.run(file.path, file.relative_path);
  // symbols, events, usages and call sites cascade from files(id).
  st.deleteFileById.run(file.id);
}

interface IndexWriteScope {
  kind: IndexKind;
  /** Base root: stored with each row and used for relative paths. */
  root: string;
  generatedAt: string;
}

function writeFileRows(st: WriteStatements, scope: IndexWriteScope, file: IndexFile, existing: StoredFileState | undefined): void {
  const { upsertFile, insertSymbol, insertEvent, insertModuleUsage, insertOrmEntity, insertOrmUsage, insertIblockUsage, insertHlblockUsage, insertOptionUsage, insertSymbolFts, insertEventFts, insertRelation, setMeta, deleteSymbolsFtsForFile, deleteEventsFtsForFile, deleteEventsForFile, deleteModuleUsagesForFile, deleteOrmEntitiesForFile, deleteOrmUsagesForFile, deleteIblockUsagesForFile, deleteHlblockUsagesForFile, deleteOptionUsagesForFile, deleteSymbolsForFile, deleteRelationsForFile, deleteFileById, insertCallSite, deleteCallSitesForFile } = st;
    if (existing && existing.size === file.size && existing.mtime_ms === file.mtimeMs && existing.parser_version === PARSER_VERSION) {
      return;
    }

    if (existing) {
      deleteSymbolsFtsForFile.run(existing.id);
      deleteEventsFtsForFile.run(existing.id);
      deleteEventsForFile.run(existing.id);
      deleteModuleUsagesForFile.run(existing.id);
      deleteOrmEntitiesForFile.run(existing.id);
      deleteOrmUsagesForFile.run(existing.id);
      deleteIblockUsagesForFile.run(existing.id);
      deleteHlblockUsagesForFile.run(existing.id);
      deleteOptionUsagesForFile.run(existing.id);
      deleteSymbolsForFile.run(existing.id);
      deleteCallSitesForFile.run(existing.id);
      deleteRelationsForFile.run(file.path, file.relativePath);
    }

    const fileRow = upsertFile.get(file.kind, scope.root, file.path, file.relativePath, file.size, file.mtimeMs, file.language, scope.generatedAt, PARSER_VERSION) as { id: number };
    const fileId = fileRow.id;
    for (const symbol of file.symbols) {
      if (isCallSite(symbol)) {
        insertCallSite.run(fileId, file.kind, symbol.type, symbol.name, nullable(symbol.className), nullable(symbol.module), symbol.line, nullable(truncateSignature(symbol.signature)));
        continue;
      }
      const symbolIdRow = insertSymbol.get(
        fileId,
        file.kind,
        scope.root,
        symbol.type,
        nullable(symbol.language ?? file.language),
        symbol.name,
        nullable(symbol.module),
        nullable(symbol.fullyQualifiedName),
        nullable(symbol.namespace),
        nullable(symbol.className),
        nullable(symbol.visibility),
        symbol.static === undefined ? null : symbol.static ? 1 : 0,
        symbol.abstract === undefined ? null : symbol.abstract ? 1 : 0,
        symbol.final === undefined ? null : symbol.final ? 1 : 0,
        nullable(symbol.returnType),
        nullable(symbol.extends),
        symbol.implements && symbol.implements.length ? JSON.stringify(symbol.implements) : null,
        symbol.traits && symbol.traits.length ? JSON.stringify(symbol.traits) : null,
        symbol.parameters && symbol.parameters.length ? JSON.stringify(symbol.parameters) : null,
        nullable(symbol.handlerClass),
        nullable(symbol.handlerMethod),
        nullable(symbol.handlerFunction),
        nullable(symbol.eventName),
        nullable(symbol.agentAction),
        nullable(symbol.api),
        nullable(symbol.siteId),
        nullable(symbol.periodic),
        symbol.interval ?? null,
        symbol.file,
        symbol.line,
        symbol.lineEnd ?? null,
        nullable(symbol.signature),
        nullable(symbol.description),
        nullable(symbol.template),
        symbol.params && symbol.params.length ? JSON.stringify(symbol.params) : null
      ) as { id: number };
      insertSymbolFts.run(
        symbolIdRow.id,
        symbol.name,
        symbol.type,
        nullable(symbol.module),
        nullable(symbol.className),
        nullable(symbol.signature),
        nullable(symbol.description)
      );
      if (symbol.type === "event") {
        const eventResult = insertEvent.run(
          symbolIdRow.id,
          fileId,
          file.kind,
          scope.root,
          nullable(symbol.module),
          symbol.eventName ?? symbol.name,
          nullable(symbol.handlerClass),
          nullable(symbol.handlerMethod),
          nullable(symbol.handlerFunction),
          symbol.file,
          symbol.line,
          nullable(symbol.signature),
          nullable(symbol.description)
        );
        insertEventFts.run(
          Number(eventResult.lastInsertRowid),
          symbol.eventName ?? symbol.name,
          nullable(symbol.module),
          nullable(symbol.handlerClass),
          nullable(symbol.handlerMethod),
          nullable(symbol.handlerFunction),
          nullable(symbol.signature),
          nullable(symbol.description)
        );
        for (const relation of eventRelationsForSymbol(symbol, file)) {
          insertRelation.run(
            relation.sourceType,
            relation.sourceName,
            relation.targetType,
            relation.targetName,
            relation.relationType,
            relationFileForStorage(relation.file, file),
            relation.line,
            nullable(relation.module),
            nullable(relation.kind),
            nullable(relation.signature),
            relationMetadataJson(relation)
          );
        }
      }
      if (symbol.type === "mail_event") {
        for (const relation of mailEventRelationsForSymbol(symbol, file)) {
          insertRelation.run(
            relation.sourceType,
            relation.sourceName,
            relation.targetType,
            relation.targetName,
            relation.relationType,
            relationFileForStorage(relation.file, file),
            relation.line,
            nullable(relation.module),
            nullable(relation.kind),
            nullable(relation.signature),
            relationMetadataJson(relation)
          );
        }
      }
      if (symbol.type === "component") {
        for (const relation of componentRelationsForSymbol(symbol, file)) {
          insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, relationFileForStorage(relation.file, file), relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
        }
      }
      if (symbol.type === "agent") {
        for (const relation of agentRelationsForSymbol(symbol, file)) {
          insertRelation.run(
            relation.sourceType,
            relation.sourceName,
            relation.targetType,
            relation.targetName,
            relation.relationType,
            relationFileForStorage(relation.file, file),
            relation.line,
            nullable(relation.module),
            nullable(relation.kind),
            nullable(relation.signature),
            relationMetadataJson(relation)
          );
        }
      }
      for (const relation of inheritanceRelationsForSymbol(symbol, file)) {
        insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, relationFileForStorage(relation.file, file), relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
      }
    }
    for (const usage of file.moduleUsages ?? []) {
      insertModuleUsage.run(
        fileId,
        file.kind,
        scope.root,
        usage.module,
        usage.call,
        usage.file,
        nullable(usage.relativeFile ?? file.relativePath),
        usage.line,
        usage.signature
      );
    }
    for (const entity of file.ormEntities ?? []) {
      insertOrmEntity.run(
        fileId,
        file.kind,
        scope.root,
        entity.className,
        entity.fullyQualifiedName,
        nullable(entity.namespace),
        nullable(entity.parentClass),
        nullable(entity.module),
        nullable(entity.tableName),
        entity.file,
        nullable(entity.relativeFile ?? file.relativePath),
        entity.line,
        JSON.stringify(entity.fields),
        JSON.stringify(entity.references),
        nullable(entity.signature)
      );
      const entityName = entity.fullyQualifiedName || entity.className;
      insertRelation.run("file", file.relativePath, "orm_entity", entityName, "defines_orm_entity", relationFileForStorage(entity.file, file), entity.line, nullable(entity.module), nullable(file.kind), nullable(entity.signature), JSON.stringify({ tableName: entity.tableName }));
      // The entity's `extends` edge is written once, from its class symbol (inheritanceRelationsForSymbol).
      if (entity.tableName) {
        insertRelation.run("orm_entity", entityName, "table", entity.tableName, "maps_table", relationFileForStorage(entity.file, file), entity.line, nullable(entity.module), nullable(file.kind), nullable(entity.signature), null);
      }
      for (const reference of entity.references) {
        if (!reference.referenceClass) continue;
        insertRelation.run("orm_entity", entityName, "orm_entity", reference.referenceClass, "references_orm_entity", relationFileForStorage(entity.file, file), reference.line, nullable(entity.module), nullable(file.kind), nullable(reference.signature), JSON.stringify({ field: reference.name, type: reference.type }));
      }
    }
    for (const usage of file.ormUsages ?? []) {
      insertOrmUsage.run(fileId, file.kind, scope.root, usage.entity, usage.method, usage.usageKind, nullable(usage.module), usage.file, nullable(usage.relativeFile ?? file.relativePath), usage.line, nullable(usage.signature));
      insertRelation.run("file", file.relativePath, "orm_entity", usage.entity, "uses_orm_entity", relationFileForStorage(usage.file, file), usage.line, nullable(usage.module), nullable(file.kind), nullable(usage.signature), JSON.stringify({ method: usage.method, usageKind: usage.usageKind }));
    }
    for (const usage of file.iblockUsages ?? []) {
      const usageKind = usage.kind ?? file.kind;
      const relativeFile = usage.relativeFile ?? file.relativePath;
      insertIblockUsage.run(fileId, usageKind, scope.root, usage.iblockId, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName), nullable(usage.component));
      insertRelation.run("file", relativeFile, "iblock", usage.iblockId, "uses_iblock", relationFileForStorage(usage.file, file), usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
      if (usage.contextType && usage.contextName) {
        insertRelation.run(usage.contextType, usage.contextName, "iblock", usage.iblockId, "uses_iblock", relationFileForStorage(usage.file, file), usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
      }
      if (usage.component) {
        insertRelation.run("component", usage.component, "iblock", usage.iblockId, "uses_iblock", relationFileForStorage(usage.file, file), usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
      }
    }
    for (const usage of file.hlblockUsages ?? []) {
      const usageKind = usage.kind ?? file.kind;
      const relativeFile = usage.relativeFile ?? file.relativePath;
      insertHlblockUsage.run(fileId, usageKind, scope.root, usage.hlblockId, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName));
      insertRelation.run("file", relativeFile, "hlblock", usage.hlblockId, "uses_hlblock", relationFileForStorage(usage.file, file), usage.line, "highloadblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
      if (usage.contextType && usage.contextName) {
        insertRelation.run(usage.contextType, usage.contextName, "hlblock", usage.hlblockId, "uses_hlblock", relationFileForStorage(usage.file, file), usage.line, "highloadblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
      }
    }
    for (const usage of file.optionUsages ?? []) {
      const usageKind = usage.kind ?? file.kind;
      const relativeFile = usage.relativeFile ?? file.relativePath;
      insertOptionUsage.run(fileId, usageKind, scope.root, usage.module, usage.name, usage.operation, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName));
      insertRelation.run("file", relativeFile, "option", `${usage.module}:${usage.name}`, "uses_option", relationFileForStorage(usage.file, file), usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
      insertRelation.run("module", usage.module, "option", `${usage.module}:${usage.name}`, "defines_option", relationFileForStorage(usage.file, file), usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
      if (usage.contextType && usage.contextName) {
        insertRelation.run(usage.contextType, usage.contextName, "option", `${usage.module}:${usage.name}`, "uses_option", relationFileForStorage(usage.file, file), usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
      }
    }
    for (const relation of componentRelationsForFile(file)) {
      insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, relationFileForStorage(relation.file, file), relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
    }
    for (const relation of moduleUsageRelationsForFile(file)) {
      insertRelation.run(
        relation.sourceType,
        relation.sourceName,
        relation.targetType,
        relation.targetName,
        relation.relationType,
        relationFileForStorage(relation.file, file),
        relation.line,
        nullable(relation.module),
        nullable(relation.kind),
        nullable(relation.signature),
        relationMetadataJson(relation)
      );
    }
}

function rebuildMailEventRelations(db: DatabaseSync, st: WriteStatements, kind: IndexKind): void {
  const { insertRelation } = st;
  db.prepare("DELETE FROM bitrix_relations WHERE kind = ? AND relation_type = 'handled_by_event_handler'").run(kind);
  const mailEventRows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE s.kind = ? AND s.type = 'mail_event'
    `).all(kind) as unknown as SymbolRow[];
  const mailHandlerRows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE s.kind = ? AND s.type = 'event' AND s.module = 'main' AND s.event_name IN ('OnBeforeEventSend', 'OnBeforeEventAdd')
    `).all(kind) as unknown as SymbolRow[];
  for (const mailEvent of mailEventRows.map(rowToSymbol)) {
    for (const handler of mailHandlerRows.map(rowToSymbol)) {
      const eventName = handler.eventName ?? handler.name;
      const targetName = handler.handlerClass && handler.handlerMethod
        ? `${eventName}:${handler.handlerClass}::${handler.handlerMethod}`
        : handler.handlerFunction ? `${eventName}:${handler.handlerFunction}` : `${handler.module ?? "main"}:${eventName}`;
      insertRelation.run(
        "mail_event",
        mailEvent.eventName ?? mailEvent.name,
        "event_handler",
        targetName,
        "handled_by_event_handler",
        mailEvent.file,
        mailEvent.line,
        nullable(handler.module),
        nullable(mailEvent.kind),
        nullable(mailEvent.signature),
        JSON.stringify({ handlerEvent: `${handler.module ?? "main"}:${eventName}`, handlerFile: handler.file, handlerLine: handler.line })
      );
    }
  }
}

export interface OpenIndexWriterOptions {
  kind: IndexKind;
  /** Base root: stored with each row; relative paths are relative to it. */
  root: string;
  /** Directory this run scanned; only indexed files under it can be pruned. Defaults to `root`. */
  scanRoot?: string;
  /** Absolute paths of every file found by this run. */
  currentPaths: Iterable<string>;
  /** Re-index every file under `scanRoot`, ignoring stored size/mtime. */
  force?: boolean;
  generatedAt?: string;
}

/**
 * Incremental index writer. `open` prunes indexed files under the scanned root
 * that no longer exist (or all of them with `force`); `writeFiles` then writes
 * changed files in short transactions, so readers are never blocked for a
 * whole run and memory stays bounded; `finish` rebuilds cross-file relations
 * and index metadata. Files outside `scanRoot` are never touched, so indexing
 * one template directory no longer deletes the others.
 */
export class SqliteIndexWriter {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly st: WriteStatements,
    private readonly scope: IndexWriteScope,
    private readonly existingByPath: Map<string, StoredFileState>
  ) {}

  static async open(dbFile: string, options: OpenIndexWriterOptions): Promise<SqliteIndexWriter> {
    await ensureSqliteStore(dbFile);
    const db = openDatabase(dbFile);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      const st = prepareWriteStatements(db);
      const scanRoot = path.resolve(options.scanRoot ?? options.root);
      const currentPaths = new Set(options.currentPaths);
      const existingFiles = db.prepare("SELECT id, path, relative_path, size, mtime_ms, parser_version FROM files WHERE kind = ?").all(options.kind) as unknown as StoredFileState[];
      const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
      const toDelete = existingFiles.filter((file) => isUnderRoot(scanRoot, file.path) && (options.force || !currentPaths.has(file.path)));
      if (toDelete.length > 0) {
        db.exec("BEGIN IMMEDIATE;");
        try {
          for (const file of toDelete) {
            deleteIndexedFile(st, file);
            existingByPath.delete(file.path);
          }
          db.exec("COMMIT;");
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
      }
      return new SqliteIndexWriter(db, st, { kind: options.kind, root: options.root, generatedAt: options.generatedAt ?? new Date().toISOString() }, existingByPath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** True when `absolutePath` is indexed with the same size, mtime and parser version, so it need not be re-parsed. */
  isUnchanged(absolutePath: string, size: number, mtimeMs: number): boolean {
    const existing = this.existingByPath.get(absolutePath);
    return existing !== undefined && existing.size === size && existing.mtime_ms === mtimeMs && existing.parser_version === PARSER_VERSION;
  }

  /** Writes a batch of files in one transaction. Unchanged files are skipped. */
  writeFiles(files: IndexFile[]): void {
    if (files.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const file of files) {
        writeFileRows(this.st, this.scope, file, this.existingByPath.get(file.path));
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Rebuilds cross-file relations, records index metadata, and closes the writer. */
  finish(summary: { files: number; warnings?: IndexWarning[] }): void {
    try {
      const { kind, root, generatedAt } = this.scope;
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        rebuildMailEventRelations(this.db, this.st, kind);
        this.st.setMeta.run(`index:${kind}`, JSON.stringify({ version: 1, generatedAt, root, kind, files: summary.files }), generatedAt);
        this.st.setMeta.run(`index:${kind}:warnings`, warningMetaValue(summary.warnings), generatedAt);
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

export interface WriteManifestOptions extends WriteIndexOptions {
  /** Directory the manifest was built from; pruning is limited to it. Defaults to `manifest.root`. */
  scanRoot?: string;
}

/** Writes a complete manifest (all files of one run) through {@link SqliteIndexWriter}. */
export async function writeIndexToSqlite(dbFile: string, manifest: IndexManifest, options: WriteManifestOptions = {}): Promise<void> {
  const writer = await SqliteIndexWriter.open(dbFile, {
    kind: manifest.kind,
    root: manifest.root,
    scanRoot: options.scanRoot,
    currentPaths: manifest.files.map((file) => file.path),
    force: options.force,
    generatedAt: manifest.generatedAt
  });
  try {
    writer.writeFiles(manifest.files);
    writer.finish({ files: manifest.files.length, warnings: manifest.warnings });
  } finally {
    writer.close();
  }
}
