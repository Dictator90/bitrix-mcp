import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { promisify } from "node:util";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { ensureSqliteStore, readIndexedRecordsForFiles } from "./sqliteStore.js";
import { validateGitBase } from "./detectChanges.js";
import type { BitrixRelationRecord, SymbolRecord } from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_NEIGHBOR_DEPTH = 1;
const MAX_NEIGHBOR_DEPTH = 5;
const DEFAULT_TRAVERSE_DEPTH = 2;
const MAX_TRAVERSE_DEPTH = 8;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export type GraphDirection = "out" | "in" | "both";
export type GraphFormat = "compact" | "full";
export type ImpactRiskLevel = "low" | "medium" | "high";

export interface GraphNode {
  id: string;
  type: string;
  name: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  sourceType: string;
  sourceName: string;
  targetType: string;
  targetName: string;
  relationType: string;
  file: string;
  line: number;
  module?: string;
  kind?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphNeighbor extends Omit<GraphNode, "id"> {
  id: string;
  direction: "out" | "in";
  relationType: string;
  file: string;
  line: number;
  depth: number;
  edge?: GraphEdge;
}

export interface GraphNeighborsOptions {
  direction?: GraphDirection;
  relationType?: string;
  depth?: number;
  limit?: number;
  format?: GraphFormat;
}

export interface GraphNeighborsResult {
  node: Omit<GraphNode, "id">;
  neighbors: GraphNeighbor[];
  truncated: boolean;
}

export interface GraphTraverseOptions {
  direction?: GraphDirection;
  maxDepth?: number;
  relationTypes?: string[];
  limit?: number;
  format?: GraphFormat;
}

export interface GraphTraverseNode extends GraphNode {
  depth: number;
}

export interface GraphTraverseResult {
  start: Omit<GraphNode, "id">;
  nodes: GraphTraverseNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface ImpactRadiusOptions {
  files?: string[];
  base?: string;
  maxDepth?: number;
  relationTypes?: string[];
  includeChangedSymbols?: boolean;
  includeRisk?: boolean;
  limit?: number;
  format?: GraphFormat;
  workspaceRoot?: string;
}

export interface ImpactRisk {
  score: number;
  level: ImpactRiskLevel;
  reasons: string[];
}

export interface ImpactRadiusResult {
  base: string;
  changedFiles: string[];
  startNodes: GraphTraverseNode[];
  impacted: {
    events: GraphTraverseNode[];
    handlers: GraphTraverseNode[];
    components: GraphTraverseNode[];
    templates: GraphTraverseNode[];
    ormEntities: GraphTraverseNode[];
    agents: GraphTraverseNode[];
    mailEvents: GraphTraverseNode[];
    iblocks: GraphTraverseNode[];
    hlblocks: GraphTraverseNode[];
    modules: GraphTraverseNode[];
    options: GraphTraverseNode[];
    classes: GraphTraverseNode[];
    methods: GraphTraverseNode[];
  };
  edges: GraphEdge[];
  risk: ImpactRisk;
  truncated: boolean;
}

const HIGH_IMPACT_RELATIONS = new Set(["handles_event", "registers_event_handler", "registers_agent", "sends_mail_event", "handles_mail_event", "defines_orm_entity", "references_orm_entity", "includes_component", "uses_template", "extends", "implements"]);
const MEDIUM_IMPACT_RELATIONS = new Set(["includes_module", "uses_iblock", "uses_hlblock", "uses_option", "uses_asset"]);
const LOW_IMPACT_PATTERNS = [/doc/u, /weak/u];

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function normalizeGraphNode(type: string, name: string): GraphNode {
  const normalizedType = type.trim().toLowerCase();
  const normalizedName = normalizedType === "file" || normalizedType === "template" ? normalizeSlashes(name.trim()) : name.trim();
  if (!normalizedType || !normalizedName) {
    throw new Error("Graph node type and name must not be empty.");
  }
  return { id: `${normalizedType}:${normalizedName}`, type: normalizedType, name: normalizedName };
}

export function parseGraphNodeId(id: string): GraphNode {
  const separator = id.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid graph node id: ${id}`);
  }
  return normalizeGraphNode(id.slice(0, separator), id.slice(separator + 1));
}

function rowToRelation(row: Record<string, unknown>): BitrixRelationRecord {
  const metadataJson = row.metadata_json;
  let metadata: Record<string, unknown> | undefined;
  if (typeof metadataJson === "string" && metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: Number(row.id),
    sourceType: String(row.source_type),
    sourceName: String(row.source_name),
    targetType: String(row.target_type),
    targetName: String(row.target_name),
    relationType: String(row.relation_type),
    file: String(row.file),
    line: Number(row.line),
    module: row.module === null ? undefined : String(row.module),
    kind: row.kind === null ? undefined : String(row.kind),
    signature: row.signature === null ? undefined : String(row.signature),
    metadata
  };
}

function relationToEdge(relation: BitrixRelationRecord): GraphEdge {
  const source = normalizeGraphNode(relation.sourceType, relation.sourceName);
  const target = normalizeGraphNode(relation.targetType, relation.targetName);
  return {
    source: source.id,
    target: target.id,
    sourceType: source.type,
    sourceName: source.name,
    targetType: target.type,
    targetName: target.name,
    relationType: relation.relationType,
    file: relation.file,
    line: relation.line,
    module: relation.module,
    kind: relation.kind,
    signature: relation.signature,
    metadata: relation.metadata
  };
}

async function relationRows(dbFile: string, node: GraphNode, direction: GraphDirection, relationTypes: string[]): Promise<Array<{ relation: BitrixRelationRecord; direction: "out" | "in" }>> {
  try {
    await fs.access(dbFile);
  } catch {
    return [];
  }
  await ensureSqliteStore(dbFile);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows: Array<{ relation: BitrixRelationRecord; direction: "out" | "in" }> = [];
    const relationFilter = relationTypes.length > 0 ? ` AND relation_type IN (${relationTypes.map(() => "?").join(", ")})` : "";
    if (direction === "out" || direction === "both") {
      const outRows = db.prepare(`
        SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
        FROM bitrix_relations
        WHERE source_type = ? AND source_name = ?${relationFilter}
        ORDER BY id ASC
      `).all(node.type, node.name, ...relationTypes) as Record<string, unknown>[];
      rows.push(...outRows.map((row) => ({ relation: rowToRelation(row), direction: "out" as const })));
    }
    if (direction === "in" || direction === "both") {
      const inRows = db.prepare(`
        SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
        FROM bitrix_relations
        WHERE target_type = ? AND target_name = ?${relationFilter}
        ORDER BY id ASC
      `).all(node.type, node.name, ...relationTypes) as Record<string, unknown>[];
      rows.push(...inRows.map((row) => ({ relation: rowToRelation(row), direction: "in" as const })));
    }
    return rows;
  } finally {
    db.close();
  }
}

function applyFormatToEdge(edge: GraphEdge, format: GraphFormat | undefined): GraphEdge {
  if (format === "full") return edge;
  const { source, target, sourceType, sourceName, targetType, targetName, relationType, file, line, module, kind } = edge;
  return { source, target, sourceType, sourceName, targetType, targetName, relationType, file, line, module, kind };
}

export async function getGraphNeighbors(dbFile: string, nodeInput: { type: string; name: string }, options: GraphNeighborsOptions = {}): Promise<GraphNeighborsResult> {
  const node = normalizeGraphNode(nodeInput.type, nodeInput.name);
  const maxDepth = clampInteger(options.depth, DEFAULT_NEIGHBOR_DEPTH, 1, MAX_NEIGHBOR_DEPTH);
  const limit = clampInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const direction = options.direction ?? "out";
  const relationTypes = options.relationType ? [options.relationType] : [];
  const traverse = await traverseFromNode(dbFile, node, { direction, maxDepth, relationTypes, limit, format: options.format });
  const neighbors: GraphNeighbor[] = [];
  for (const edge of traverse.edges) {
    const edgeDirection: "out" | "in" = edge.source === node.id ? "out" : "in";
    const neighborId = edgeDirection === "out" ? edge.target : edge.source;
    const neighborNode = traverse.nodes.find((candidate) => candidate.id === neighborId) ?? { ...parseGraphNodeId(neighborId), depth: 1 };
    neighbors.push({
      id: neighborNode.id,
      type: neighborNode.type,
      name: neighborNode.name,
      direction: edgeDirection,
      relationType: edge.relationType,
      file: edge.file,
      line: edge.line,
      depth: neighborNode.depth,
      edge: options.format === "full" ? edge : undefined
    });
  }
  return { node: { type: node.type, name: node.name }, neighbors: neighbors.slice(0, limit), truncated: traverse.truncated || neighbors.length > limit };
}

async function traverseFromNode(dbFile: string, start: GraphNode, options: Required<Pick<GraphTraverseOptions, "direction" | "maxDepth" | "relationTypes" | "limit">> & Pick<GraphTraverseOptions, "format">): Promise<GraphTraverseResult> {
  const nodes = new Map<string, GraphTraverseNode>([[start.id, { ...start, depth: 0 }]]);
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const queue: GraphTraverseNode[] = [{ ...start, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= options.maxDepth) continue;
    const rows = await relationRows(dbFile, current, options.direction, options.relationTypes);
    for (const { relation, direction } of rows) {
      const rawEdge = relationToEdge(relation);
      const edge = applyFormatToEdge(rawEdge, options.format);
      const edgeKey = `${edge.source}->${edge.relationType}->${edge.target}:${edge.file}:${edge.line}`;
      const nextId = direction === "out" ? edge.target : edge.source;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push(edge);
      }
      if (!nodes.has(nextId)) {
        const parsed = parseGraphNodeId(nextId);
        const nextNode = { ...parsed, depth: current.depth + 1 };
        nodes.set(nextId, nextNode);
        queue.push(nextNode);
      }
      if (nodes.size > options.limit || edges.length > options.limit) {
        truncated = true;
        return { start: { type: start.type, name: start.name }, nodes: [...nodes.values()].slice(0, options.limit), edges: edges.slice(0, options.limit), truncated };
      }
    }
  }

  return { start: { type: start.type, name: start.name }, nodes: [...nodes.values()], edges, truncated };
}

export async function traverseGraph(dbFile: string, startNode: { type: string; name: string }, options: GraphTraverseOptions = {}): Promise<GraphTraverseResult> {
  const start = normalizeGraphNode(startNode.type, startNode.name);
  return traverseFromNode(dbFile, start, {
    direction: options.direction ?? "out",
    maxDepth: clampInteger(options.maxDepth, DEFAULT_TRAVERSE_DEPTH, 0, MAX_TRAVERSE_DEPTH),
    relationTypes: options.relationTypes ?? [],
    limit: clampInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    format: options.format
  });
}

async function gitChangedFiles(workspaceRoot: string, base: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "diff", "--name-only", base, "--"], { maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/u).map((file) => normalizeSlashes(file.trim())).filter(Boolean);
  } catch {
    return [];
  }
}

function symbolToNode(symbol: SymbolRecord): GraphNode | undefined {
  if (["class", "interface", "trait", "function", "method", "event", "component", "agent", "mail_event"].includes(symbol.type)) {
    if (symbol.type === "event" && symbol.module && symbol.eventName) return normalizeGraphNode("event", `${symbol.module}:${symbol.eventName}`);
    return normalizeGraphNode(symbol.type, symbol.fullyQualifiedName ?? symbol.name);
  }
  return undefined;
}

function impactedGroups(): ImpactRadiusResult["impacted"] {
  return { events: [], handlers: [], components: [], templates: [], ormEntities: [], agents: [], mailEvents: [], iblocks: [], hlblocks: [], modules: [], options: [], classes: [], methods: [] };
}

function addImpactedNode(groups: ImpactRadiusResult["impacted"], node: GraphTraverseNode): void {
  const add = (key: keyof ImpactRadiusResult["impacted"]): void => {
    if (!groups[key].some((item) => item.id === node.id)) groups[key].push(node);
  };
  switch (node.type) {
    case "event": add("events"); break;
    case "handler": add("handlers"); break;
    case "component": add("components"); break;
    case "template": add("templates"); break;
    case "orm_entity": add("ormEntities"); break;
    case "agent": add("agents"); break;
    case "mail_event": add("mailEvents"); break;
    case "iblock": add("iblocks"); break;
    case "hlblock": add("hlblocks"); break;
    case "module": add("modules"); break;
    case "option": add("options"); break;
    case "class": add("classes"); break;
    case "method": add("methods"); add("handlers"); break;
  }
}

function scoreImpactRisk(edges: GraphEdge[]): ImpactRisk {
  let score = 0;
  const reasons = new Set<string>();
  for (const edge of edges) {
    if (HIGH_IMPACT_RELATIONS.has(edge.relationType)) {
      score += 18;
      reasons.add(`high-impact relation ${edge.relationType}`);
    } else if (MEDIUM_IMPACT_RELATIONS.has(edge.relationType)) {
      score += 8;
      reasons.add(`medium-impact relation ${edge.relationType}`);
    } else if (LOW_IMPACT_PATTERNS.some((pattern) => pattern.test(edge.relationType))) {
      score += 1;
      reasons.add(`low-impact relation ${edge.relationType}`);
    } else {
      score += 3;
    }
  }
  const capped = Math.max(0, Math.min(100, score));
  return { score: capped, level: capped >= 40 ? "high" : capped >= 15 ? "medium" : "low", reasons: [...reasons] };
}

export async function getImpactRadius(dbFile: string, options: ImpactRadiusOptions = {}): Promise<ImpactRadiusResult> {
  const base = validateGitBase(options.base);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const changedFiles = (options.files && options.files.length > 0 ? options.files : await gitChangedFiles(workspaceRoot, base)).slice(0, MAX_LIMIT).map((file) => normalizeSlashes(file));
  const fileCandidates = changedFiles.flatMap((file) => [file, path.resolve(workspaceRoot, file)]);
  const indexed = await readIndexedRecordsForFiles(dbFile, fileCandidates, { includeRelations: true });
  const startNodeMap = new Map<string, GraphNode>();

  for (const file of changedFiles) {
    const node = normalizeGraphNode("file", file);
    startNodeMap.set(node.id, node);
  }
  for (const relation of indexed.relations) {
    const source = normalizeGraphNode(relation.sourceType, relation.sourceName);
    const target = normalizeGraphNode(relation.targetType, relation.targetName);
    startNodeMap.set(source.id, source);
    startNodeMap.set(target.id, target);
  }
  if (options.includeChangedSymbols !== false) {
    for (const symbol of indexed.symbols) {
      const node = symbolToNode(symbol);
      if (node) startNodeMap.set(node.id, node);
    }
  }

  const limit = clampInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxDepth = clampInteger(options.maxDepth, DEFAULT_TRAVERSE_DEPTH, 0, MAX_TRAVERSE_DEPTH);
  const allNodes = new Map<string, GraphTraverseNode>();
  const allEdges = new Map<string, GraphEdge>();
  let truncated = false;

  for (const startNode of startNodeMap.values()) {
    const traversal = await traverseGraph(dbFile, startNode, { direction: "both", maxDepth, relationTypes: options.relationTypes, limit, format: options.format });
    truncated = truncated || traversal.truncated;
    for (const node of traversal.nodes) {
      const existing = allNodes.get(node.id);
      if (!existing || node.depth < existing.depth) allNodes.set(node.id, node);
    }
    for (const edge of traversal.edges) {
      allEdges.set(`${edge.source}->${edge.relationType}->${edge.target}:${edge.file}:${edge.line}`, edge);
    }
    if (allNodes.size > limit || allEdges.size > limit) {
      truncated = true;
      break;
    }
  }

  const impacted = impactedGroups();
  for (const node of allNodes.values()) addImpactedNode(impacted, node);
  const edges = [...allEdges.values()].slice(0, limit);
  return {
    base,
    changedFiles,
    startNodes: [...startNodeMap.values()].map((node) => ({ ...node, depth: 0 })).slice(0, limit),
    impacted,
    edges,
    risk: options.includeRisk === false ? { score: 0, level: "low", reasons: [] } : scoreImpactRisk(edges),
    truncated: truncated || allNodes.size > limit || allEdges.size > limit
  };
}

export async function getImpactRadiusForPaths(paths: RuntimePaths, options: ImpactRadiusOptions = {}): Promise<ImpactRadiusResult> {
  return getImpactRadius(sqlitePath(paths.dataDir), { ...options, workspaceRoot: paths.workspaceRoot });
}
