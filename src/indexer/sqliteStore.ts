import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { componentNameFromRelativePath, possibleComponentTemplateRelativePaths } from "./template.js";
import type { BitrixRelationRecord, ComponentParamRecord, IndexFile, IndexKind, IndexManifest, IndexWarning, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OrmFieldRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";

export interface SqliteStoreOptions {
  dbFile: string;
}

export interface SqliteSearchQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

export interface AgentSearchQuery {
  query?: string;
  module?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface SymbolContextSearchQuery {
  name: string;
  type?: Extract<SymbolRecord["type"], "class" | "interface" | "trait" | "function" | "method" | "event" | "component" | "constant">;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface MailEventSearchQuery {
  query?: string;
  eventName?: string;
  api?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  includeHandlers?: boolean;
  limit?: number;
}

export interface MailEventSearchResult extends SymbolRecord {
  handlers?: SymbolRecord[];
}
export interface ComponentSearchQuery {
  query?: string;
  component?: string;
  template?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface ComponentContextQuery {
  component: string;
  template?: string;
  callFile?: string;
  includeFiles?: boolean;
  includeAssets?: boolean;
  includeParams?: boolean;
  format?: "compact" | "full";
}

export interface ComponentContextResult {
  component: string;
  template: string;
  calls: SymbolRecord[];
  templateFiles: IndexFile[];
  assets: IndexFile[];
  parameters: ComponentParamRecord[];
  relations: BitrixRelationRecord[];
  possibleTemplatePaths?: string[];
}

export interface ModuleUsageSearchQuery {
  module?: string;
  call?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface IblockUsageSearchQuery {
  query?: string;
  iblockId?: string;
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface HlblockUsageSearchQuery {
  query?: string;
  hlblockId?: string;
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface OptionSearchQuery {
  query?: string;
  module?: string;
  name?: string;
  operation?: "get" | "set";
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface OrmSearchQuery {
  query?: string;
  tableName?: string;
  className?: string;
  module?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  limit?: number;
}

export interface OrmEntityMapQuery {
  className?: string;
  tableName?: string;
  file?: string;
}

export interface OrmUsageSearchQuery {
  query?: string;
  entity?: string;
  method?: string;
  file?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  limit?: number;
}

export interface BitrixRelationSearchQuery {
  sourceType?: string;
  sourceName?: string;
  targetType?: string;
  targetName?: string;
  relationType?: string;
  module?: string;
  kind?: string;
  file?: string;
  limit?: number;
}

export interface WriteBitrixRelationsOptions {
  clearKind?: string;
  clearFile?: string;
}

export interface ExistingIndexFile {
  id: number;
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface FileRow {
  id: number;
  kind: string;
  root: string;
  path: string;
  relative_path: string;
  size: number;
  mtime_ms: number;
  language: string;
  indexed_at: string;
}

interface SymbolRow {
  kind: IndexKind;
  type: SymbolRecord["type"];
  language: string | null;
  name: string;
  module: string | null;
  class_name: string | null;
  handler_class?: string | null;
  handler_method?: string | null;
  handler_function?: string | null;
  event_name?: string | null;
  file: string;
  line: number;
  line_end?: number | null;
  signature: string | null;
  description: string | null;
  agent_action?: SymbolRecord["agentAction"] | null;
  api?: string | null;
  site_id?: string | null;
  periodic?: string | null;
  interval?: number | null;
  relative_file?: string | null;
  component_template?: string | null;
  params_json?: string | null;
}

interface ModuleUsageRow {
  id: number;
  file_id: number;
  kind: IndexKind;
  root: string;
  module: string;
  call: ModuleUsageRecord["call"];
  file: string;
  relative_file: string | null;
  line: number;
  signature: string;
}


interface IblockUsageRow {
  id: number;
  file_id: number;
  kind: IndexKind;
  root: string;
  iblock_id: string;
  api: string;
  file: string;
  relative_file: string | null;
  line: number;
  signature: string;
  context_type: IblockUsageRecord["contextType"] | null;
  context_name: string | null;
  component: string | null;
}

interface HlblockUsageRow {
  id: number;
  file_id: number;
  kind: IndexKind;
  root: string;
  hlblock_id: string;
  api: string;
  file: string;
  relative_file: string | null;
  line: number;
  signature: string;
  context_type: HlblockUsageRecord["contextType"] | null;
  context_name: string | null;
}

interface OptionUsageRow {
  id: number;
  file_id: number;
  kind: IndexKind;
  root: string;
  module: string;
  name: string;
  operation: OptionUsageRecord["operation"];
  api: string;
  file: string;
  relative_file: string | null;
  line: number;
  signature: string;
  context_type: OptionUsageRecord["contextType"] | null;
  context_name: string | null;
}

interface OrmEntityRow {
  id: number;
  kind: IndexKind;
  root: string;
  class_name: string;
  fully_qualified_name: string;
  namespace: string | null;
  parent_class: string | null;
  module: string | null;
  table_name: string | null;
  file: string;
  relative_file: string | null;
  line: number;
  fields_json: string;
  references_json: string;
  signature: string | null;
}

interface OrmUsageRow {
  id: number;
  kind: IndexKind;
  root: string;
  entity: string;
  method: string;
  usage_kind: OrmUsageRecord["usageKind"];
  module: string | null;
  file: string;
  relative_file: string | null;
  line: number;
  signature: string | null;
}

interface BitrixRelationRow {
  id: number;
  source_type: string;
  source_name: string;
  target_type: string;
  target_name: string;
  relation_type: string;
  file: string;
  line: number;
  module: string | null;
  kind: string | null;
  signature: string | null;
  metadata_json: string | null;
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    kind: row.kind,
    type: row.type,
    language: row.language ?? undefined,
    name: row.name,
    module: row.module ?? undefined,
    className: row.class_name ?? undefined,
    handlerClass: row.handler_class ?? undefined,
    handlerMethod: row.handler_method ?? undefined,
    handlerFunction: row.handler_function ?? undefined,
    eventName: row.event_name ?? undefined,
    file: row.file,
    line: row.line,
    lineEnd: row.line_end ?? undefined,
    signature: row.signature ?? undefined,
    description: row.description ?? undefined,
    agentAction: row.agent_action ?? undefined,
    api: row.api ?? undefined,
    siteId: row.site_id ?? undefined,
    periodic: row.periodic ?? undefined,
    interval: row.interval ?? undefined,
    relativeFile: row.relative_file ?? undefined,
    template: row.component_template ?? undefined,
    params: row.params_json ? parseJsonArray<ComponentParamRecord>(row.params_json) : undefined
  };
}

function rowToModuleUsage(row: ModuleUsageRow): ModuleUsageRecord {
  return {
    type: "module_usage",
    kind: row.kind,
    module: row.module,
    call: row.call,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature
  };
}

function parseRelationMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}


function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}


function rowToIblockUsage(row: IblockUsageRow): IblockUsageRecord {
  return {
    type: "iblock_usage",
    kind: row.kind,
    iblockId: row.iblock_id,
    api: row.api,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature,
    contextType: row.context_type ?? undefined,
    contextName: row.context_name ?? undefined,
    component: row.component ?? undefined
  };
}

function rowToHlblockUsage(row: HlblockUsageRow): HlblockUsageRecord {
  return {
    type: "hlblock_usage",
    kind: row.kind,
    hlblockId: row.hlblock_id,
    api: row.api,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature,
    contextType: row.context_type ?? undefined,
    contextName: row.context_name ?? undefined
  };
}

function rowToOptionUsage(row: OptionUsageRow): OptionUsageRecord {
  return {
    type: "option",
    kind: row.kind,
    module: row.module,
    name: row.name,
    operation: row.operation,
    api: row.api,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature,
    contextType: row.context_type ?? undefined,
    contextName: row.context_name ?? undefined
  };
}

function rowToOrmEntity(row: OrmEntityRow): OrmEntityRecord {
  return {
    type: "orm_entity",
    kind: row.kind,
    className: row.class_name,
    fullyQualifiedName: row.fully_qualified_name,
    namespace: row.namespace ?? undefined,
    parentClass: row.parent_class ?? undefined,
    module: row.module ?? undefined,
    tableName: row.table_name ?? undefined,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    fields: parseJsonArray<OrmFieldRecord>(row.fields_json),
    references: parseJsonArray<OrmFieldRecord>(row.references_json),
    signature: row.signature ?? undefined
  };
}

function rowToOrmUsage(row: OrmUsageRow): OrmUsageRecord {
  return {
    type: "orm_usage",
    kind: row.kind,
    entity: row.entity,
    method: row.method,
    usageKind: row.usage_kind,
    module: row.module ?? undefined,
    file: row.file,
    relativeFile: row.relative_file ?? undefined,
    line: row.line,
    signature: row.signature ?? undefined
  };
}

function rowToBitrixRelation(row: BitrixRelationRow): BitrixRelationRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    targetType: row.target_type,
    targetName: row.target_name,
    relationType: row.relation_type,
    file: row.file,
    line: row.line,
    module: row.module ?? undefined,
    kind: row.kind ?? undefined,
    signature: row.signature ?? undefined,
    metadata: parseRelationMetadata(row.metadata_json)
  };
}


function staticAgentTarget(name: string): string | undefined {
  return /^\\?[A-Za-z_][A-Za-z0-9_\\]*::[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : undefined;
}

function agentRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
  if (symbol.type !== "agent") return [];
  const relations: BitrixRelationRecord[] = [
    {
      sourceType: "file",
      sourceName: file.relativePath,
      targetType: "agent",
      targetName: symbol.name,
      relationType: symbol.agentAction === "RemoveAgent" ? "removes_agent" : symbol.agentAction === "GetList" ? "queries_agents" : "registers_agent",
      file: symbol.file,
      line: symbol.line,
      module: symbol.module,
      kind: file.kind,
      signature: symbol.signature,
      metadata: { action: symbol.agentAction, periodic: symbol.periodic, interval: symbol.interval }
    }
  ];
  if (symbol.module) {
    relations.push({
      sourceType: "module",
      sourceName: symbol.module,
      targetType: "agent",
      targetName: symbol.name,
      relationType: symbol.agentAction === "RemoveAgent" ? "removes_agent" : symbol.agentAction === "GetList" ? "queries_agents" : "registers_agent",
      file: symbol.file,
      line: symbol.line,
      module: symbol.module,
      kind: file.kind,
      signature: symbol.signature,
      metadata: { action: symbol.agentAction, periodic: symbol.periodic, interval: symbol.interval }
    });
  }
  const methodTarget = staticAgentTarget(symbol.name);
  if (methodTarget && symbol.agentAction === "AddAgent") {
    relations.push({
      sourceType: "agent",
      sourceName: symbol.name,
      targetType: "method",
      targetName: methodTarget,
      relationType: "calls_method",
      file: symbol.file,
      line: symbol.line,
      module: symbol.module,
      kind: file.kind,
      signature: symbol.signature
    });
  }
  return relations;
}

function mailEventRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
  if (symbol.type !== "mail_event") return [];
  return [{
    sourceType: "file",
    sourceName: file.relativePath,
    targetType: "mail_event",
    targetName: symbol.eventName ?? symbol.name,
    relationType: "sends_mail_event",
    file: symbol.file,
    line: symbol.line,
    module: symbol.module,
    kind: file.kind,
    signature: symbol.signature,
    metadata: { api: symbol.api, siteId: symbol.siteId }
  }];
}

function moduleUsageRelationsForFile(file: IndexFile): BitrixRelationRecord[] {
  return (file.moduleUsages ?? []).map((usage) => ({
    sourceType: "file",
    sourceName: file.relativePath,
    targetType: "module",
    targetName: usage.module,
    relationType: "includes_module",
    file: usage.file,
    line: usage.line,
    module: usage.module,
    kind: file.kind,
    signature: usage.signature,
    metadata: { call: usage.call }
  }));
}


function componentRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
  if (symbol.type !== "component") return [];
  const template = symbol.template ?? ".default";
  const relations: BitrixRelationRecord[] = [{
    sourceType: "file",
    sourceName: file.relativePath,
    targetType: "component",
    targetName: symbol.name,
    relationType: "includes_component",
    file: symbol.file,
    line: symbol.line,
    module: symbol.module,
    kind: file.kind,
    signature: symbol.signature,
    metadata: { template, params: symbol.params ?? [] }
  }, {
    sourceType: "component",
    sourceName: symbol.name,
    targetType: "template",
    targetName: `${symbol.name}:${template}`,
    relationType: "uses_template",
    file: symbol.file,
    line: symbol.line,
    module: symbol.module,
    kind: file.kind,
    signature: symbol.signature,
    metadata: { template, possiblePaths: possibleComponentTemplateRelativePaths(symbol.name, template) }
  }];
  const iblockId = symbol.params?.find((param) => param.name === "IBLOCK_ID")?.value;
  if (iblockId !== undefined && iblockId !== "unknown") {
    relations.push({
      sourceType: "component",
      sourceName: symbol.name,
      targetType: "iblock",
      targetName: String(iblockId),
      relationType: "uses_iblock",
      file: symbol.file,
      line: symbol.line,
      module: "iblock",
      kind: file.kind,
      signature: symbol.signature,
      metadata: { param: "IBLOCK_ID", template }
    });
  }
  return relations;
}

function componentRelationsForFile(file: IndexFile): BitrixRelationRecord[] {
  const info = componentNameFromRelativePath(file.relativePath);
  if (!info) return [];
  const relationType = info.role === "asset" ? "component_asset" : info.role === "template" ? "component_template_file" : "component_file";
  const targetType = info.role === "asset" ? "asset" : "file";
  return [{
    sourceType: "component",
    sourceName: info.component,
    targetType,
    targetName: file.relativePath,
    relationType,
    file: file.path,
    line: 1,
    kind: file.kind,
    metadata: { template: info.template, role: info.role }
  }];
}

function eventHandlerTarget(symbol: SymbolRecord): { targetType: string; targetName: string; metadata?: Record<string, unknown> } | undefined {
  if (symbol.handlerClass && symbol.handlerMethod) {
    return { targetType: "method", targetName: `${symbol.handlerClass}::${symbol.handlerMethod}` };
  }
  if (symbol.handlerFunction) {
    if (symbol.anonymous) {
      return { targetType: "function", targetName: symbol.handlerFunction, metadata: { anonymous: true } };
    }
    return { targetType: "function", targetName: symbol.handlerFunction };
  }
  return undefined;
}

function eventRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
  if (symbol.type !== "event") return [];
  const eventName = symbol.eventName ?? (symbol.name.split(":").slice(1).join(":") || symbol.name);
  const eventSourceName = symbol.module ? `${symbol.module}:${eventName}` : symbol.name;
  const target = eventHandlerTarget(symbol);
  const relations: BitrixRelationRecord[] = [];
  if (target) {
    relations.push({
      sourceType: "event",
      sourceName: eventSourceName,
      targetType: target.targetType,
      targetName: target.targetName,
      relationType: "handles_event",
      file: symbol.file,
      line: symbol.line,
      module: symbol.module,
      kind: file.kind,
      signature: symbol.signature,
      metadata: target.metadata
    });
  }
  relations.push({
    sourceType: "file",
    sourceName: file.relativePath,
    targetType: "event",
    targetName: eventSourceName,
    relationType: "registers_event_handler",
    file: symbol.file,
    line: symbol.line,
    module: symbol.module,
    kind: file.kind,
    signature: symbol.signature,
    metadata: symbol.anonymous ? { anonymous: true } : undefined
  });
  return relations;
}

export async function ensureSqliteStore(dbFile: string): Promise<void> {
  await fs.mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(kind, path)
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        type TEXT NOT NULL,
        language TEXT,
        name TEXT NOT NULL,
        module TEXT,
        class_name TEXT,
        handler_class TEXT,
        handler_method TEXT,
        handler_function TEXT,
        event_name TEXT,
        agent_action TEXT,
        api TEXT,
        site_id TEXT,
        periodic TEXT,
        interval INTEGER,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        line_end INTEGER,
        signature TEXT,
        description TEXT,
        component_template TEXT,
        params_json TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT,
        name TEXT NOT NULL,
        handler_class TEXT,
        handler_method TEXT,
        handler_function TEXT,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS module_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT NOT NULL,
        call TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hlblock_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        hlblock_id TEXT NOT NULL,
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT
      );

      CREATE TABLE IF NOT EXISTS option_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        module TEXT NOT NULL,
        name TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('get', 'set')),
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT
      );

      CREATE TABLE IF NOT EXISTS orm_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        class_name TEXT NOT NULL,
        fully_qualified_name TEXT NOT NULL,
        namespace TEXT,
        parent_class TEXT,
        module TEXT,
        table_name TEXT,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        references_json TEXT NOT NULL,
        signature TEXT
      );

      CREATE TABLE IF NOT EXISTS orm_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        entity TEXT NOT NULL,
        method TEXT NOT NULL,
        usage_kind TEXT NOT NULL,
        module TEXT,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT
      );

      CREATE TABLE IF NOT EXISTS iblock_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        iblock_id TEXT NOT NULL,
        api TEXT NOT NULL,
        file TEXT NOT NULL,
        relative_file TEXT,
        line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        context_type TEXT,
        context_name TEXT,
        component TEXT
      );

      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER REFERENCES doc_sources(id) ON DELETE SET NULL,
        uri TEXT NOT NULL UNIQUE,
        title TEXT,
        path TEXT,
        mime_type TEXT,
        source_name TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS doc_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        heading_path TEXT,
        section_anchor TEXT,
        source_uri TEXT,
        relative_path TEXT,
        embedding BLOB,
        UNIQUE(doc_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS doc_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('git', 'path')),
        uri TEXT NOT NULL,
        root_path TEXT,
        checkout_path TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(type, uri)
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bitrix_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_name TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        module TEXT,
        kind TEXT,
        signature TEXT,
        metadata_json TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name, type, module, class_name, signature, description
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        name, module, handler_class, handler_method, handler_function, signature, description
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        uri, title, path, text
      );

      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(type, module, name);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
      CREATE INDEX IF NOT EXISTS idx_module_usages_module ON module_usages(module);
      CREATE INDEX IF NOT EXISTS idx_module_usages_call ON module_usages(call);
      CREATE INDEX IF NOT EXISTS idx_module_usages_kind ON module_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_module_usages_file ON module_usages(file);
      CREATE INDEX IF NOT EXISTS idx_module_usages_relative_file ON module_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_class ON orm_entities(class_name);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_table ON orm_entities(table_name);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_kind ON orm_entities(kind);
      CREATE INDEX IF NOT EXISTS idx_orm_entities_file ON orm_entities(file);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_entity ON orm_usages(entity);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_method ON orm_usages(method);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_kind ON orm_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_orm_usages_file ON orm_usages(file);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_iblock_id ON iblock_usages(iblock_id);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_api ON iblock_usages(api);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_kind ON iblock_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_file ON iblock_usages(file);
      CREATE INDEX IF NOT EXISTS idx_iblock_usages_relative_file ON iblock_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_hlblock_id ON hlblock_usages(hlblock_id);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_api ON hlblock_usages(api);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_kind ON hlblock_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_file ON hlblock_usages(file);
      CREATE INDEX IF NOT EXISTS idx_hlblock_usages_relative_file ON hlblock_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_option_usages_module ON option_usages(module);
      CREATE INDEX IF NOT EXISTS idx_option_usages_name ON option_usages(name);
      CREATE INDEX IF NOT EXISTS idx_option_usages_operation ON option_usages(operation);
      CREATE INDEX IF NOT EXISTS idx_option_usages_api ON option_usages(api);
      CREATE INDEX IF NOT EXISTS idx_option_usages_kind ON option_usages(kind);
      CREATE INDEX IF NOT EXISTS idx_option_usages_file ON option_usages(file);
      CREATE INDEX IF NOT EXISTS idx_option_usages_relative_file ON option_usages(relative_file);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_relation_type ON bitrix_relations(relation_type);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_source ON bitrix_relations(source_type, source_name);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_target ON bitrix_relations(target_type, target_name);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_file ON bitrix_relations(file);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_kind ON bitrix_relations(kind);
      CREATE INDEX IF NOT EXISTS idx_bitrix_relations_module ON bitrix_relations(module);

      INSERT OR IGNORE INTO symbols_fts (rowid, name, type, module, class_name, signature, description)
      SELECT id, name, type, module, class_name, signature, description FROM symbols;


      INSERT OR IGNORE INTO docs_fts (rowid, uri, title, path, text)
      SELECT doc_chunks.id, docs.uri, docs.title, docs.path, doc_chunks.text
      FROM doc_chunks
      JOIN docs ON docs.id = doc_chunks.doc_id;
    `);

    const docSourceColumns = (db.prepare("PRAGMA table_info(doc_sources)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!docSourceColumns.includes("type")) {
      db.exec(`
        DROP TABLE IF EXISTS doc_sources;
        CREATE TABLE doc_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('git', 'path')),
          uri TEXT NOT NULL,
          root_path TEXT,
          checkout_path TEXT,
          name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(type, uri)
        );
      `);
    }

    const docColumns = (db.prepare("PRAGMA table_info(docs)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!docColumns.includes("source_id")) {
      db.exec("ALTER TABLE docs ADD COLUMN source_id INTEGER REFERENCES doc_sources(id) ON DELETE SET NULL;");
    }
    if (!docColumns.includes("source_name")) {
      db.exec("ALTER TABLE docs ADD COLUMN source_name TEXT;");
    }
    if (!docColumns.includes("size")) {
      db.exec("ALTER TABLE docs ADD COLUMN size INTEGER NOT NULL DEFAULT 0;");
    }
    if (!docColumns.includes("mtime_ms")) {
      db.exec("ALTER TABLE docs ADD COLUMN mtime_ms REAL NOT NULL DEFAULT 0;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source_id);");

    const docChunkColumns = (db.prepare("PRAGMA table_info(doc_chunks)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["heading_path", "TEXT"],
      ["section_anchor", "TEXT"],
      ["source_uri", "TEXT"],
      ["relative_path", "TEXT"]
    ] as const) {
      if (!docChunkColumns.includes(column)) {
        db.exec(`ALTER TABLE doc_chunks ADD COLUMN ${column} ${definition};`);
      }
    }

    const symbolColumns = (db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["handler_class", "TEXT"],
      ["handler_method", "TEXT"],
      ["handler_function", "TEXT"],
      ["event_name", "TEXT"],
      ["agent_action", "TEXT"],
      ["api", "TEXT"],
      ["site_id", "TEXT"],
      ["periodic", "TEXT"],
      ["interval", "INTEGER"],
      ["language", "TEXT"],
      ["component_template", "TEXT"],
      ["params_json", "TEXT"],
      ["line_end", "INTEGER"]
    ] as const) {
      if (!symbolColumns.includes(column)) {
        db.exec(`ALTER TABLE symbols ADD COLUMN ${column} ${definition};`);
      }
    }

    const eventColumns = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((column) => column.name);
    for (const [column, definition] of [
      ["handler_class", "TEXT"],
      ["handler_method", "TEXT"],
      ["handler_function", "TEXT"]
    ] as const) {
      if (!eventColumns.includes(column)) {
        db.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition};`);
      }
    }

    const eventFtsColumns = (db.prepare("PRAGMA table_info(events_fts)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!eventFtsColumns.includes("handler_class")) {
      db.exec(`
        DROP TABLE IF EXISTS events_fts;
        CREATE VIRTUAL TABLE events_fts USING fts5(
          name, module, handler_class, handler_method, handler_function, signature, description
        );
      `);
    }
    db.exec(`
      INSERT OR IGNORE INTO events_fts (rowid, name, module, handler_class, handler_method, handler_function, signature, description)
      SELECT id, name, module, handler_class, handler_method, handler_function, signature, description FROM events;
    `);

  } finally {
    db.close();
  }
}

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
    phpParseFallbackFiles: new Set(diagnostics.map((warning) => warning.file)).size,
    diagnostics
  });
}

function parseWarningMeta(value: string): { phpParseFallbackFiles: number; diagnostics: IndexWarning[] } {
  try {
    const parsed = JSON.parse(value) as { phpParseFallbackFiles?: unknown; diagnostics?: unknown };
    return {
      phpParseFallbackFiles: typeof parsed.phpParseFallbackFiles === "number" ? parsed.phpParseFallbackFiles : 0,
      diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics.filter((entry): entry is IndexWarning => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "php_parse_fallback" && typeof (entry as { file?: unknown }).file === "string" && typeof (entry as { message?: unknown }).message === "string") : []
    };
  } catch {
    return { phpParseFallbackFiles: 0, diagnostics: [] };
  }
}

export async function writeIndexToSqlite(dbFile: string, manifest: IndexManifest, options: WriteIndexOptions = {}): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const upsertFile = db.prepare(`
      INSERT INTO files (kind, root, path, relative_path, size, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, path) DO UPDATE SET
        root = excluded.root,
        relative_path = excluded.relative_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        language = excluded.language,
        indexed_at = excluded.indexed_at
      RETURNING id
    `);
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (file_id, kind, root, type, language, name, module, class_name, handler_class, handler_method, handler_function, event_name, agent_action, api, site_id, periodic, interval, file, line, line_end, signature, description, component_template, params_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const existingFiles = db.prepare("SELECT id, path, relative_path, size, mtime_ms FROM files WHERE kind = ?").all(manifest.kind) as Array<{ id: number; path: string; relative_path: string; size: number; mtime_ms: number }>;
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const currentPaths = new Set(manifest.files.map((file) => file.path));
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
    const deleteRelationsForFile = db.prepare("DELETE FROM bitrix_relations WHERE file = ?");
    const deleteFileById = db.prepare("DELETE FROM files WHERE id = ?");

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (options.force) {
        db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE kind = ?)").run(manifest.kind);
        db.prepare("DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE kind = ?)").run(manifest.kind);
        db.prepare("DELETE FROM bitrix_relations WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM module_usages WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM orm_entities WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM orm_usages WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM iblock_usages WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM hlblock_usages WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM option_usages WHERE kind = ?").run(manifest.kind);
        db.prepare("DELETE FROM files WHERE kind = ?").run(manifest.kind);
        existingByPath.clear();
      } else {
        for (const file of existingFiles) {
          if (!currentPaths.has(file.path)) {
            deleteSymbolsFtsForFile.run(file.id);
            deleteEventsFtsForFile.run(file.id);
            deleteModuleUsagesForFile.run(file.id);
            deleteOrmEntitiesForFile.run(file.id);
            deleteOrmUsagesForFile.run(file.id);
            deleteIblockUsagesForFile.run(file.id);
            deleteHlblockUsagesForFile.run(file.id);
            deleteOptionUsagesForFile.run(file.id);
            deleteRelationsForFile.run(file.path);
            deleteFileById.run(file.id);
            existingByPath.delete(file.path);
          }
        }
      }

      for (const file of manifest.files) {
        const existing = existingByPath.get(file.path);
        if (existing && existing.size === file.size && existing.mtime_ms === file.mtimeMs) {
          continue;
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
          deleteRelationsForFile.run(file.path);
        }

        const fileRow = upsertFile.get(file.kind, manifest.root, file.path, file.relativePath, file.size, file.mtimeMs, file.language, manifest.generatedAt) as { id: number };
        const fileId = fileRow.id;
        for (const symbol of file.symbols) {
          const symbolIdRow = insertSymbol.get(
            fileId,
            file.kind,
            manifest.root,
            symbol.type,
            nullable(symbol.language ?? file.language),
            symbol.name,
            nullable(symbol.module),
            nullable(symbol.className),
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
              manifest.root,
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
                relation.file,
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
                relation.file,
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
              insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, relation.file, relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
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
                relation.file,
                relation.line,
                nullable(relation.module),
                nullable(relation.kind),
                nullable(relation.signature),
                relationMetadataJson(relation)
              );
            }
          }
        }
        for (const usage of file.moduleUsages ?? []) {
          insertModuleUsage.run(
            fileId,
            file.kind,
            manifest.root,
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
            manifest.root,
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
          insertRelation.run("file", file.relativePath, "orm_entity", entityName, "defines_orm_entity", entity.file, entity.line, nullable(entity.module), nullable(file.kind), nullable(entity.signature), JSON.stringify({ tableName: entity.tableName }));
          if (entity.parentClass) {
            insertRelation.run("class", entityName, "parent_class", entity.parentClass, "extends", entity.file, entity.line, nullable(entity.module), nullable(file.kind), nullable(entity.signature), null);
          }
          if (entity.tableName) {
            insertRelation.run("orm_entity", entityName, "table", entity.tableName, "maps_table", entity.file, entity.line, nullable(entity.module), nullable(file.kind), nullable(entity.signature), null);
          }
          for (const reference of entity.references) {
            if (!reference.referenceClass) continue;
            insertRelation.run("orm_entity", entityName, "orm_entity", reference.referenceClass, "references_orm_entity", entity.file, reference.line, nullable(entity.module), nullable(file.kind), nullable(reference.signature), JSON.stringify({ field: reference.name, type: reference.type }));
          }
        }
        for (const usage of file.ormUsages ?? []) {
          insertOrmUsage.run(fileId, file.kind, manifest.root, usage.entity, usage.method, usage.usageKind, nullable(usage.module), usage.file, nullable(usage.relativeFile ?? file.relativePath), usage.line, nullable(usage.signature));
          insertRelation.run("file", file.relativePath, "orm_entity", usage.entity, "uses_orm_entity", usage.file, usage.line, nullable(usage.module), nullable(file.kind), nullable(usage.signature), JSON.stringify({ method: usage.method, usageKind: usage.usageKind }));
        }
        for (const usage of file.iblockUsages ?? []) {
          const usageKind = usage.kind ?? file.kind;
          const relativeFile = usage.relativeFile ?? file.relativePath;
          insertIblockUsage.run(fileId, usageKind, manifest.root, usage.iblockId, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName), nullable(usage.component));
          insertRelation.run("file", relativeFile, "iblock", usage.iblockId, "uses_iblock", usage.file, usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
          if (usage.contextType && usage.contextName) {
            insertRelation.run(usage.contextType, usage.contextName, "iblock", usage.iblockId, "uses_iblock", usage.file, usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
          }
          if (usage.component) {
            insertRelation.run("component", usage.component, "iblock", usage.iblockId, "uses_iblock", usage.file, usage.line, "iblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
          }
        }
        for (const usage of file.hlblockUsages ?? []) {
          const usageKind = usage.kind ?? file.kind;
          const relativeFile = usage.relativeFile ?? file.relativePath;
          insertHlblockUsage.run(fileId, usageKind, manifest.root, usage.hlblockId, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName));
          insertRelation.run("file", relativeFile, "hlblock", usage.hlblockId, "uses_hlblock", usage.file, usage.line, "highloadblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
          if (usage.contextType && usage.contextName) {
            insertRelation.run(usage.contextType, usage.contextName, "hlblock", usage.hlblockId, "uses_hlblock", usage.file, usage.line, "highloadblock", nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api }));
          }
        }
        for (const usage of file.optionUsages ?? []) {
          const usageKind = usage.kind ?? file.kind;
          const relativeFile = usage.relativeFile ?? file.relativePath;
          insertOptionUsage.run(fileId, usageKind, manifest.root, usage.module, usage.name, usage.operation, usage.api, usage.file, nullable(relativeFile), usage.line, usage.signature, nullable(usage.contextType), nullable(usage.contextName));
          insertRelation.run("file", relativeFile, "option", `${usage.module}:${usage.name}`, "uses_option", usage.file, usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
          insertRelation.run("module", usage.module, "option", `${usage.module}:${usage.name}`, "defines_option", usage.file, usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
          if (usage.contextType && usage.contextName) {
            insertRelation.run(usage.contextType, usage.contextName, "option", `${usage.module}:${usage.name}`, "uses_option", usage.file, usage.line, usage.module, nullable(usageKind), nullable(usage.signature), JSON.stringify({ api: usage.api, operation: usage.operation }));
          }
        }
        for (const relation of componentRelationsForFile(file)) {
          insertRelation.run(relation.sourceType, relation.sourceName, relation.targetType, relation.targetName, relation.relationType, relation.file, relation.line, nullable(relation.module), nullable(relation.kind), nullable(relation.signature), relationMetadataJson(relation));
        }
        for (const relation of moduleUsageRelationsForFile(file)) {
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
      }

      db.prepare("DELETE FROM bitrix_relations WHERE kind = ? AND relation_type = 'handled_by_event_handler'").run(manifest.kind);
      const mailEventRows = db.prepare(`
          SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
                 s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
          FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE s.kind = ? AND s.type = 'mail_event'
        `).all(manifest.kind) as unknown as SymbolRow[];
      const mailHandlerRows = db.prepare(`
          SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
                 s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
          FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE s.kind = ? AND s.type = 'event' AND s.module = 'main' AND s.event_name IN ('OnBeforeEventSend', 'OnBeforeEventAdd')
        `).all(manifest.kind) as unknown as SymbolRow[];
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
      setMeta.run(`index:${manifest.kind}`, JSON.stringify({ version: manifest.version, generatedAt: manifest.generatedAt, root: manifest.root, kind: manifest.kind, files: manifest.files.length }), manifest.generatedAt);
      setMeta.run(`index:${manifest.kind}:warnings`, warningMetaValue(manifest.warnings), manifest.generatedAt);
      setMeta.run("schema_version", "3", manifest.generatedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}


function relationMetadataJson(relation: BitrixRelationRecord): string | null {
  return relation.metadata === undefined ? null : JSON.stringify(relation.metadata);
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
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
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
               s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
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
      filters.push("(s.file = ? OR f.relative_path = ?)");
      params.push(query.file, query.file);
    }
    const kinds = query.kind === undefined ? [] : Array.isArray(query.kind) ? query.kind : [query.kind];
    if (kinds.length > 0) {
      filters.push(`s.kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }

    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 20)));
    const rows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
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
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
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
    for (const [column, value] of [
      ["source_type", query.sourceType],
      ["source_name", query.sourceName],
      ["target_type", query.targetType],
      ["target_name", query.targetName],
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
      SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
      FROM bitrix_relations
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params) as unknown as BitrixRelationRow[];
    return rows.map(rowToBitrixRelation);
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
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
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
    const symbolSelect = db.prepare("SELECT kind, type, language, name, module, class_name, handler_class, handler_method, handler_function, event_name, agent_action, api, site_id, periodic, interval, file, line, line_end, signature, description, component_template, params_json FROM symbols WHERE file_id = ? ORDER BY id");
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


export interface IndexStatus {
  dbFile: string;
  files: number;
  symbols: number;
  events: number;
  moduleUsages: number;
  hlblockUsages: number;
  optionUsages: number;
  documents: number;
  docChunks: number;
  phpParseFallbackFiles: number;
  lastIndexedAt?: string;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
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
      symbols: countRows(db, "symbols"),
      events: countRows(db, "events"),
      moduleUsages: countRows(db, "module_usages"),
      hlblockUsages: countRows(db, "hlblock_usages"),
      optionUsages: countRows(db, "option_usages"),
      documents: countRows(db, "docs"),
      docChunks: countRows(db, "doc_chunks"),
      phpParseFallbackFiles: countPhpParseFallbackFiles(db),
      lastIndexedAt: lastIndexedRow.last_indexed_at ?? undefined
    };
  } finally {
    db.close();
  }
}

export interface ExistingDocIndexMetadata {
  uri: string;
  sourceId?: number;
  size: number;
  mtimeMs: number;
}

export interface DocIndexChunk {
  uri: string;
  sourceId?: number;
  sourceName?: string;
  title?: string;
  path?: string;
  mimeType?: string;
  size: number;
  mtimeMs: number;
  chunkIndex: number;
  text: string;
  headingPath?: string;
  sectionAnchor?: string;
  sourceUri?: string;
  relativePath?: string;
}

export interface WriteDocsOptions {
  sourceId?: number;
  currentUris?: Iterable<string>;
}

export async function readExistingDocsBySource(dbFile: string, sourceId: number): Promise<ExistingDocIndexMetadata[]> {
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const rows = db.prepare("SELECT uri, source_id, size, mtime_ms FROM docs WHERE source_id = ?").all(sourceId) as Array<{ uri: string; source_id: number | null; size: number; mtime_ms: number }>;
    return rows.map((row) => ({ uri: row.uri, sourceId: row.source_id ?? undefined, size: row.size, mtimeMs: row.mtime_ms }));
  } finally {
    db.close();
  }
}

export async function writeDocsToSqlite(dbFile: string, chunks: DocIndexChunk[], options: WriteDocsOptions = {}, indexedAt = new Date().toISOString()): Promise<void> {
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insertDoc = db.prepare(`
      INSERT INTO docs (source_id, source_name, uri, title, path, mime_type, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        source_id = excluded.source_id,
        source_name = excluded.source_name,
        title = excluded.title,
        path = excluded.path,
        mime_type = excluded.mime_type,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
      RETURNING id
    `);
    const insertChunk = db.prepare(`
      INSERT INTO doc_chunks (doc_id, chunk_index, text, heading_path, section_anchor, source_uri, relative_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, chunk_index) DO UPDATE SET
        text = excluded.text,
        heading_path = excluded.heading_path,
        section_anchor = excluded.section_anchor,
        source_uri = excluded.source_uri,
        relative_path = excluded.relative_path
      RETURNING id
    `);
    const insertFts = db.prepare("INSERT INTO docs_fts (rowid, uri, title, path, text) VALUES (?, ?, ?, ?, ?)");
    const deleteFtsForDoc = db.prepare("DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE doc_id = ?)");
    const deleteChunksForDoc = db.prepare("DELETE FROM doc_chunks WHERE doc_id = ?");
    const deleteDocById = db.prepare("DELETE FROM docs WHERE id = ?");
    const selectChangedDoc = db.prepare("SELECT id FROM docs WHERE uri = ?");
    const setMeta = db.prepare(`
      INSERT INTO index_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      if (options.sourceId !== undefined && options.currentUris) {
        const currentUris = new Set(options.currentUris);
        const existingDocs = db.prepare("SELECT id, uri FROM docs WHERE source_id = ?").all(options.sourceId) as Array<{ id: number; uri: string }>;
        for (const doc of existingDocs) {
          if (!currentUris.has(doc.uri)) {
            deleteFtsForDoc.run(doc.id);
            deleteDocById.run(doc.id);
          }
        }
      }

      const changedUris = new Set(chunks.map((chunk) => chunk.uri));
      for (const uri of changedUris) {
        const doc = selectChangedDoc.get(uri) as { id: number } | undefined;
        if (doc) {
          deleteFtsForDoc.run(doc.id);
          deleteChunksForDoc.run(doc.id);
        }
      }

      for (const chunk of chunks) {
        const doc = insertDoc.get(chunk.sourceId ?? null, nullable(chunk.sourceName), chunk.uri, nullable(chunk.title), nullable(chunk.path), nullable(chunk.mimeType), chunk.size, chunk.mtimeMs, indexedAt) as { id: number };
        const row = insertChunk.get(
          doc.id,
          chunk.chunkIndex,
          chunk.text,
          nullable(chunk.headingPath),
          nullable(chunk.sectionAnchor),
          nullable(chunk.sourceUri),
          nullable(chunk.relativePath)
        ) as { id: number };
        insertFts.run(row.id, chunk.uri, nullable(chunk.title), nullable(chunk.path), chunk.text);
      }
      const totalChunks = (db.prepare("SELECT COUNT(*) AS count FROM doc_chunks").get() as { count: number }).count;
      setMeta.run("index:docs", JSON.stringify({ generatedAt: indexedAt, chunks: totalChunks }), indexedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

export { searchSqliteLiveApi, searchSqliteDocs } from "../liveapi/search.js";

export interface IndexedRecordsForFiles {
  symbols: SymbolRecord[];
  moduleUsages: ModuleUsageRecord[];
  relations: BitrixRelationRecord[];
}

export async function readIndexedRecordsForFiles(dbFile: string, files: string[], options: { includeRelations?: boolean } = {}): Promise<IndexedRecordsForFiles> {
  if (files.length === 0) {
    return { symbols: [], moduleUsages: [], relations: [] };
  }
  try {
    await fs.access(dbFile);
  } catch {
    return { symbols: [], moduleUsages: [], relations: [] };
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const normalized = files.map((file) => file.replace(/\\/g, "/"));
    const placeholders = normalized.map(() => "?").join(", ");
    const symbolRows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE f.relative_path IN (${placeholders}) OR s.file IN (${placeholders})
      ORDER BY f.relative_path, s.line, s.id
    `).all(...normalized, ...normalized) as unknown as SymbolRow[];

    const moduleUsageRows = db.prepare(`
      SELECT m.id, m.file_id, m.kind, m.root, m.module, m.call, m.file, m.relative_file, m.line, m.signature
      FROM module_usages m
      JOIN files f ON f.id = m.file_id
      WHERE f.relative_path IN (${placeholders}) OR m.relative_file IN (${placeholders}) OR m.file IN (${placeholders})
      ORDER BY coalesce(m.relative_file, m.file), m.line, m.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as ModuleUsageRow[];

    let relationRows: BitrixRelationRow[] = [];
    if (options.includeRelations !== false) {
      relationRows = db.prepare(`
        SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
        FROM bitrix_relations
        WHERE file IN (${placeholders})
        ORDER BY file, line, id
      `).all(...normalized) as unknown as BitrixRelationRow[];
    }

    return {
      symbols: symbolRows.map(rowToSymbol),
      moduleUsages: moduleUsageRows.map(rowToModuleUsage),
      relations: relationRows.map(rowToBitrixRelation)
    };
  } finally {
    db.close();
  }
}
