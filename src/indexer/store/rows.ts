import path from "node:path";
import type { BitrixRelationRecord, ComponentParamRecord, IndexFile, IndexKind, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OrmFieldRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../../types.js";

export interface FileRow {
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

export interface SymbolRow {
  kind: IndexKind;
  type: SymbolRecord["type"];
  language: string | null;
  name: string;
  module: string | null;
  fully_qualified_name?: string | null;
  namespace?: string | null;
  class_name: string | null;
  visibility?: SymbolRecord["visibility"] | null;
  is_static?: number | null;
  is_abstract?: number | null;
  is_final?: number | null;
  return_type?: string | null;
  extends_name?: string | null;
  implements_json?: string | null;
  traits_json?: string | null;
  parameters_json?: string | null;
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

export interface ModuleUsageRow {
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


export interface IblockUsageRow {
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

export interface HlblockUsageRow {
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

export interface OptionUsageRow {
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

export interface OrmEntityRow {
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

export interface OrmUsageRow {
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

export interface BitrixRelationRow {
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

export function nullable(value: string | undefined): string | null {
  return value ?? null;
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function normalizedFileLookupCandidates(file: string): string[] {
  const normalized = normalizeSlashes(file.trim());
  const withoutCurrentDir = normalized.replace(/^\.\//u, "");
  return Array.from(new Set([normalized, withoutCurrentDir].filter(Boolean)));
}

export function fileLookupClause(columns: string[], valueCount: number): string {
  const placeholders = Array.from({ length: valueCount }, () => "?").join(", ");
  return `(${columns.map((column) => `replace(${column}, char(92), '/') IN (${placeholders})`).join(" OR ")})`;
}

export function relationFileForStorage(relationFile: string, file: IndexFile): string {
  const normalizedRelationFile = normalizeSlashes(relationFile);
  const normalizedAbsolutePath = normalizeSlashes(file.path);
  return normalizedRelationFile === normalizedAbsolutePath ? file.relativePath : normalizedRelationFile;
}


export function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    kind: row.kind,
    type: row.type,
    language: row.language ?? undefined,
    name: row.name,
    module: row.module ?? undefined,
    fullyQualifiedName: row.fully_qualified_name ?? undefined,
    namespace: row.namespace ?? undefined,
    className: row.class_name ?? undefined,
    visibility: row.visibility ?? undefined,
    static: row.is_static === null || row.is_static === undefined ? undefined : row.is_static === 1,
    abstract: row.is_abstract === null || row.is_abstract === undefined ? undefined : row.is_abstract === 1,
    final: row.is_final === null || row.is_final === undefined ? undefined : row.is_final === 1,
    returnType: row.return_type ?? undefined,
    extends: row.extends_name ?? undefined,
    implements: row.implements_json ? parseJsonArray<string>(row.implements_json) : undefined,
    traits: row.traits_json ? parseJsonArray<string>(row.traits_json) : undefined,
    parameters: row.parameters_json ? parseJsonArray<NonNullable<SymbolRecord["parameters"]>[number]>(row.parameters_json) : undefined,
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

export function rowToModuleUsage(row: ModuleUsageRow): ModuleUsageRecord {
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


export function rowToIblockUsage(row: IblockUsageRow): IblockUsageRecord {
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

export function rowToHlblockUsage(row: HlblockUsageRow): HlblockUsageRecord {
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

export function rowToOptionUsage(row: OptionUsageRow): OptionUsageRecord {
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

export function rowToOrmEntity(row: OrmEntityRow): OrmEntityRecord {
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

export function rowToOrmUsage(row: OrmUsageRow): OrmUsageRecord {
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

export function rowToBitrixRelation(row: BitrixRelationRow): BitrixRelationRecord {
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

export function relationMetadataJson(relation: BitrixRelationRecord): string | null {
  return relation.metadata === undefined ? null : JSON.stringify(relation.metadata);
}
