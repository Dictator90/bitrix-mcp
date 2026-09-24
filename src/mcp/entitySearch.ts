import { z } from "zod";
import { searchAgents, searchAutoloadRecords, searchBitrixRelations, searchComponents, searchHlblockUsages, searchIblockUsages, searchInheritanceRelations, searchMailEvents, searchModuleUsages, searchOptionUsages, searchOrmEntities, searchOrmUsages } from "../indexer/sqliteStore.js";
import type { AutoloadRecordType, IndexKind } from "../types.js";
import { cursorSchema, pageRequest, paginate, type ResultEnvelope } from "./envelope.js";
import { formatAgentSearchResults, formatAutoloadSearchResults, formatBitrixRelationSearchResults, formatComponentSearchResults, formatHlblockUsageSearchResults, formatIblockUsageSearchResults, formatInheritanceResults, formatMailEventSearchResults, formatModuleUsageSearchResults, formatOptionSearchResults, formatOrmEntityResults, formatOrmUsageResults } from "./format.js";
import { formatSchema, INDEX_KINDS, NODE_TYPES_DESCRIPTION, RELATION_TYPES_DESCRIPTION } from "./schemas.js";

export const ENTITY_TYPES = [
  "agent", "mail_event", "component", "module_usage", "iblock_usage", "hlblock_usage",
  "option", "orm_entity", "orm_usage", "autoload", "relation", "inheritance"
] as const;

export type EntityType = typeof ENTITY_TYPES[number];

const ENTITY_KINDS = [...INDEX_KINDS, "autoload"] as const;
const entityKindSchema = z.enum(ENTITY_KINDS);

export const DEFAULT_ENTITY_LIMIT = 20;
export const MAX_ENTITY_LIMIT = 100;

/**
 * Input of bitrix_entity_search. One flat object (not a discriminated union)
 * so every MCP client renders it; filters that do not apply to the chosen
 * entity are ignored and reported in `warnings`.
 */
export const entitySearchShape = {
  entity: z.enum(ENTITY_TYPES).describe("What to search. agent: CAgent registrations; mail_event: CEvent::Send/SendImmediate calls; component: IncludeComponent calls; module_usage: Loader::includeModule/CModule checks; iblock_usage / hlblock_usage: IBlock and Highloadblock API calls; option: Option::get/set reads and writes; orm_entity: D7 DataManager entities; orm_usage: ORM calls (getList/add/update/...); autoload: Composer autoload/dependency/bootstrap records; relation: raw graph edges; inheritance: classes that extend/implement/use a target."),
  query: z.string().optional().describe("Free-text filter (substring). Used by agent, mail_event, component, iblock_usage, hlblock_usage, option, orm_entity, orm_usage, autoload; for inheritance it is an alias of target."),
  module: z.string().optional().describe("Bitrix module id, e.g. iblock or vendor.module (agent, module_usage, option, orm_entity, relation, inheritance)."),
  kind: z.union([entityKindSchema, z.array(entityKindSchema).min(1).max(5)]).optional().describe("Index kind: project, template, bitrix, install; relation also accepts autoload. relation takes a single kind."),
  file: z.string().optional().describe("Indexed file path filter (agent, mail_event, component, module_usage, iblock_usage, hlblock_usage, option, orm_usage, relation)."),
  eventName: z.string().optional().describe("mail_event: mail event type, e.g. SALE_NEW_ORDER."),
  api: z.string().optional().describe("API call filter, e.g. CEvent::Send, CIBlockElement::GetList, HighloadBlockTable::getById, Option::get (mail_event, iblock_usage, hlblock_usage, option)."),
  includeHandlers: z.boolean().optional().describe("mail_event: also return OnBeforeEventSend/OnBeforeEventAdd handlers."),
  component: z.string().optional().describe("component: component name, e.g. bitrix:catalog.section."),
  template: z.string().optional().describe("component: component template name, e.g. .default."),
  call: z.string().optional().describe("module_usage: call, e.g. Loader::includeModule, CModule::IncludeModule, IsModuleInstalled."),
  iblockId: z.string().optional().describe("iblock_usage: IBLOCK_ID value or constant name."),
  hlblockId: z.string().optional().describe("hlblock_usage: HLBLOCK id or code."),
  name: z.string().optional().describe("option: option name."),
  operation: z.enum(["get", "set"]).optional().describe("option: get (read) or set (write)."),
  className: z.string().optional().describe("orm_entity: DataManager class name."),
  tableName: z.string().optional().describe("orm_entity: database table name."),
  ormEntity: z.string().optional().describe("orm_usage: entity class, e.g. Vendor\\Module\\ProductTable."),
  method: z.string().optional().describe("orm_usage: method, e.g. getList, add, update, delete, query."),
  namespace: z.string().optional().describe("autoload: exact PSR-4 namespace prefix, e.g. Vendor\\Module\\."),
  package: z.string().optional().describe("autoload: Composer package name, e.g. phpunit/phpunit."),
  autoloadType: z.enum(["psr-4", "files", "classmap", "dependency", "dev_dependency", "bootstrap"]).optional().describe("autoload: record type: psr-4, files, classmap, dependency, dev_dependency, bootstrap."),
  sourceType: z.string().optional().describe(`relation: source node type. ${NODE_TYPES_DESCRIPTION}`),
  sourceName: z.string().optional().describe("relation: source node name, e.g. main:OnBeforeProlog or local/php_interface/init.php."),
  targetType: z.string().optional().describe("relation: target node type (same values as sourceType)."),
  targetName: z.string().optional().describe("relation: target node name."),
  relationType: z.string().optional().describe(`relation: edge type. ${RELATION_TYPES_DESCRIPTION}`),
  target: z.string().optional().describe("inheritance: parent class, interface or trait. A name with a backslash matches that exact FQN; a short name matches the last namespace segment. Case-insensitive."),
  relation: z.enum(["extends", "implements", "uses_trait", "any"]).optional().describe("inheritance: extends, implements, uses_trait, or any (default)."),
  transitive: z.boolean().optional().describe("inheritance: also return indirect descendants, breadth-first and cycle-safe; each result has depth."),
  maxDepth: z.number().int().min(1).max(10).optional().describe("inheritance: transitive depth; default 5."),
  limit: z.number().int().min(1).max(MAX_ENTITY_LIMIT).default(DEFAULT_ENTITY_LIMIT).describe(`Page size, 1-${MAX_ENTITY_LIMIT}; default ${DEFAULT_ENTITY_LIMIT}.`),
  cursor: cursorSchema,
  format: formatSchema
};

export const entitySearchSchema = z.object(entitySearchShape);
export type EntitySearchInput = z.input<typeof entitySearchSchema>;

/** Arguments of the entitySearch worker task: the tool input with the cursor decoded to an offset. */
export type EntitySearchArgs = Omit<EntitySearchInput, "cursor"> & { offset?: number };

type FilterKey = Exclude<keyof EntitySearchArgs, "entity" | "limit" | "offset" | "format">;

/** Filters each entity understands; anything else is reported as ignored. */
export const ENTITY_FILTERS: Record<EntityType, readonly FilterKey[]> = {
  agent: ["query", "module", "kind", "file"],
  mail_event: ["query", "eventName", "api", "kind", "file", "includeHandlers"],
  component: ["query", "component", "template", "kind", "file"],
  module_usage: ["module", "call", "kind", "file"],
  iblock_usage: ["query", "iblockId", "api", "kind", "file"],
  hlblock_usage: ["query", "hlblockId", "api", "kind", "file"],
  option: ["query", "module", "name", "operation", "api", "kind", "file"],
  orm_entity: ["query", "tableName", "className", "module", "kind"],
  orm_usage: ["query", "ormEntity", "method", "file", "kind"],
  autoload: ["query", "namespace", "package", "autoloadType"],
  relation: ["sourceType", "sourceName", "targetType", "targetName", "relationType", "module", "kind", "file"],
  inheritance: ["target", "query", "relation", "kind", "module", "transitive", "maxDepth"]
};

function ignoredFilterWarnings(args: EntitySearchArgs): string[] {
  const allowed = new Set<string>(ENTITY_FILTERS[args.entity]);
  const ignored = Object.entries(args)
    .filter(([key, value]) => value !== undefined && !["entity", "limit", "offset", "format"].includes(key) && !allowed.has(key))
    .map(([key]) => key);
  return ignored.length > 0 ? [`Ignored filters for entity=${args.entity}: ${ignored.join(", ")}. Supported: ${ENTITY_FILTERS[args.entity].join(", ")}.`] : [];
}

/** Index kinds only (drops the relation-only "autoload" kind). */
function indexKinds(kind: EntitySearchArgs["kind"]): IndexKind | IndexKind[] | undefined {
  if (kind === undefined) return undefined;
  const list = (Array.isArray(kind) ? kind : [kind]).filter((value): value is Exclude<typeof value, "autoload"> => value !== "autoload");
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

/** Runs one entity search page against the SQLite index (inside a worker). */
export async function runEntitySearch(dbFile: string, args: EntitySearchArgs): Promise<ResultEnvelope> {
  const page = pageRequest(args.limit ?? DEFAULT_ENTITY_LIMIT, args.offset ?? 0);
  const limit = page.fetch;
  const format = args.format;
  const warnings = ignoredFilterWarnings(args);
  const kind = indexKinds(args.kind);
  const envelope = <T>(rows: T[] | undefined, formatter: (items: T[]) => unknown[] | undefined) => paginate(rows, page, formatter, { entity: args.entity, warnings });
  if (args.entity !== "relation" && args.kind !== undefined && kind === undefined) {
    warnings.push("kind=autoload applies to entity=relation only; nothing else is indexed under it.");
    return envelope([], (rows) => rows);
  }

  switch (args.entity) {
    case "agent":
      return envelope(await searchAgents(dbFile, { query: args.query, module: args.module, kind, file: args.file, limit }), (rows) => formatAgentSearchResults(rows, { format }));
    case "mail_event":
      return envelope(await searchMailEvents(dbFile, { query: args.query, eventName: args.eventName, api: args.api, kind, file: args.file, includeHandlers: args.includeHandlers, limit }), (rows) => formatMailEventSearchResults(rows, { format }));
    case "component":
      return envelope(await searchComponents(dbFile, { query: args.query, component: args.component, template: args.template, kind, file: args.file, limit }), (rows) => formatComponentSearchResults(rows, { format }));
    case "module_usage":
      return envelope(await searchModuleUsages(dbFile, { module: args.module, call: args.call, kind, file: args.file, limit }), (rows) => formatModuleUsageSearchResults(rows, { format }));
    case "iblock_usage":
      return envelope(await searchIblockUsages(dbFile, { query: args.query, iblockId: args.iblockId, api: args.api, kind, file: args.file, limit }), (rows) => formatIblockUsageSearchResults(rows, { format }));
    case "hlblock_usage":
      return envelope(await searchHlblockUsages(dbFile, { query: args.query, hlblockId: args.hlblockId, api: args.api, kind, file: args.file, limit }), (rows) => formatHlblockUsageSearchResults(rows, { format }));
    case "option":
      return envelope(await searchOptionUsages(dbFile, { query: args.query, module: args.module, name: args.name, operation: args.operation, api: args.api, kind, file: args.file, limit }), (rows) => formatOptionSearchResults(rows, { format }));
    case "orm_entity":
      return envelope(await searchOrmEntities(dbFile, { query: args.query, tableName: args.tableName, className: args.className, module: args.module, kind, limit }), (rows) => formatOrmEntityResults(rows, { format }));
    case "orm_usage":
      return envelope(await searchOrmUsages(dbFile, { query: args.query, entity: args.ormEntity, method: args.method, file: args.file, kind, limit }), (rows) => formatOrmUsageResults(rows, { format }));
    case "autoload":
      return envelope(await searchAutoloadRecords(dbFile, { query: args.query, namespace: args.namespace, package: args.package, type: args.autoloadType as AutoloadRecordType | undefined, limit }), (rows) => formatAutoloadSearchResults(rows, { format }));
    case "relation": {
      const kinds = args.kind === undefined ? [] : Array.isArray(args.kind) ? args.kind : [args.kind];
      if (kinds.length > 1) warnings.push(`entity=relation takes a single kind; used ${kinds[0]}.`);
      return envelope(await searchBitrixRelations(dbFile, { sourceType: args.sourceType, sourceName: args.sourceName, targetType: args.targetType, targetName: args.targetName, relationType: args.relationType, module: args.module, kind: kinds[0], file: args.file, limit }), (rows) => formatBitrixRelationSearchResults(rows, { format }));
    }
    case "inheritance": {
      const target = args.target ?? args.query;
      if (!target) throw new Error("bitrix_entity_search: entity=inheritance requires target (a parent class, interface, or trait name).");
      return envelope(await searchInheritanceRelations(dbFile, { target, relation: args.relation ?? "any", kind, module: args.module, limit, transitive: args.transitive, maxDepth: args.maxDepth }), (rows) => formatInheritanceResults(rows, { format }));
    }
  }
}
