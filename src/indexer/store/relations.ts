import { componentNameFromRelativePath, possibleComponentTemplateRelativePaths } from "../template.js";
import type { BitrixRelationRecord, IndexFile, SymbolRecord } from "../../types.js";

function staticAgentTarget(name: string): string | undefined {
  return /^\\?[A-Za-z_][A-Za-z0-9_\\]*::[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : undefined;
}

export function agentRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
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

export function mailEventRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
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

export function moduleUsageRelationsForFile(file: IndexFile): BitrixRelationRecord[] {
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


export function componentRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
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

export function componentRelationsForFile(file: IndexFile): BitrixRelationRecord[] {
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

/**
 * Graph node type of every PHP class-like declaration (class, interface, trait). Inheritance
 * edges point at `class:<FQN>` for parents, interfaces and traits alike, so a declaration's own
 * node and the edges that reference it share one node id; `relation_type` (`extends` /
 * `implements` / `uses_trait`) carries the meaning. Rows written by older parser versions used
 * `parent_class`, `interface` and `trait` target types: readers treat those as aliases of `class`.
 */
export const CLASS_NODE_TYPE = "class";
export const LEGACY_CLASS_NODE_TYPES: readonly string[] = ["parent_class", "interface", "trait"];
export const INHERITANCE_RELATION_TYPES: readonly string[] = ["extends", "implements", "uses_trait"];

/** PHP class, function and method names are case-insensitive, so are their graph nodes. */
const CASE_INSENSITIVE_NODE_TYPES = new Set(["class", "method", "function", "orm_entity"]);

/** Maps a node type onto its canonical form (legacy class-like types become `class`). */
export function canonicalGraphNodeType(type: string): string {
  const normalized = type.trim().toLowerCase();
  return LEGACY_CLASS_NODE_TYPES.includes(normalized) ? CLASS_NODE_TYPE : normalized;
}

/** Every stored `source_type` / `target_type` value that denotes the given node type. */
export function storedGraphNodeTypes(type: string): string[] {
  const canonical = canonicalGraphNodeType(type);
  return canonical === CLASS_NODE_TYPE ? [CLASS_NODE_TYPE, ...LEGACY_CLASS_NODE_TYPES] : [canonical];
}

export function isCaseInsensitiveNodeType(type: string): boolean {
  return CASE_INSENSITIVE_NODE_TYPES.has(canonicalGraphNodeType(type));
}

/** Canonical PHP name used for comparisons: no leading backslash, lower case. */
export function phpNameKey(name: string): string {
  return name.trim().replace(/^\\+/u, "").toLowerCase();
}

/**
 * Read-time normalization of stored relation rows: legacy class-like node types become `class`
 * (the original type is kept as `metadata.targetKind` / `metadata.sourceKind` when not already set).
 */
export function normalizeStoredRelation(relation: BitrixRelationRecord): BitrixRelationRecord {
  const sourceType = canonicalGraphNodeType(relation.sourceType);
  const targetType = canonicalGraphNodeType(relation.targetType);
  if (sourceType === relation.sourceType && targetType === relation.targetType) return relation;
  const metadata: Record<string, unknown> = { ...(relation.metadata ?? {}) };
  if (sourceType !== relation.sourceType && metadata.sourceKind === undefined) metadata.sourceKind = relation.sourceType === "parent_class" ? "class" : relation.sourceType;
  if (targetType !== relation.targetType && metadata.targetKind === undefined) metadata.targetKind = relation.targetType === "parent_class" ? "class" : relation.targetType;
  return { ...relation, sourceType, targetType, metadata };
}

export function inheritanceRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
  if (symbol.type !== "class" && symbol.type !== "interface" && symbol.type !== "trait") return [];
  const sourceName = symbol.fullyQualifiedName ?? symbol.name;
  const base = {
    sourceType: CLASS_NODE_TYPE,
    sourceName,
    targetType: CLASS_NODE_TYPE,
    file: symbol.file,
    line: symbol.line,
    module: symbol.module,
    kind: file.kind,
    signature: symbol.signature
  };
  const relations: BitrixRelationRecord[] = [];
  if (symbol.extends) {
    relations.push({ ...base, targetName: symbol.extends, relationType: "extends", metadata: { sourceKind: symbol.type, targetKind: symbol.type } });
  }
  for (const interfaceName of symbol.implements ?? []) {
    relations.push({ ...base, targetName: interfaceName, relationType: "implements", metadata: { sourceKind: symbol.type, targetKind: "interface" } });
  }
  for (const traitName of symbol.traits ?? []) {
    relations.push({ ...base, targetName: traitName, relationType: "uses_trait", metadata: { sourceKind: symbol.type, targetKind: "trait" } });
  }
  return relations;
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

export function eventRelationsForSymbol(symbol: SymbolRecord, file: IndexFile): BitrixRelationRecord[] {
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

/**
 * Schema version stored in `PRAGMA user_version`. Bump it whenever
 * {@link migrateSchema} gains a step, so existing databases run it once.
 */
