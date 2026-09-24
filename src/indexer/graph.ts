import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import path from "node:path";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { ensureSqliteStore, readIndexedRecordsForFiles } from "./sqliteStore.js";
import { gitChangedFileEntries, gitUnavailableWarning, validateGitBase } from "./gitChanges.js";
import { canonicalGraphNodeType, isCaseInsensitiveNodeType, normalizeStoredRelation, phpNameKey, storedGraphNodeTypes } from "./store/relations.js";
import type { BitrixRelationRecord, SymbolRecord } from "../types.js";

const DEFAULT_NEIGHBOR_DEPTH = 1;
const MAX_NEIGHBOR_DEPTH = 5;
const DEFAULT_TRAVERSE_DEPTH = 2;
const MAX_TRAVERSE_DEPTH = 8;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** Frontier names per `IN (…)` query; well below SQLite's bound-parameter limit. */
const FRONTIER_CHUNK = 400;
const RELATION_COLUMNS = "id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json";

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
  /** Maximum edges read per node and direction (hub protection); defaults to `limit`. */
  maxEdgesPerNode?: number;
  format?: GraphFormat;
}

export interface GraphNeighborsResult {
  node: Omit<GraphNode, "id">;
  neighbors: GraphNeighbor[];
  truncated: boolean;
  /** Node ids whose edges were cut by the per-node edge cap. */
  truncatedNodes?: string[];
}

export interface GraphTraverseOptions {
  direction?: GraphDirection;
  maxDepth?: number;
  relationTypes?: string[];
  limit?: number;
  /** Maximum edges read per node and direction (hub protection); defaults to `limit`. */
  maxEdgesPerNode?: number;
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
  /** Node ids whose edges were cut by the per-node edge cap. */
  truncatedNodes?: string[];
}

export interface ImpactRadiusOptions {
  files?: string[];
  base?: string;
  maxDepth?: number;
  relationTypes?: string[];
  includeChangedSymbols?: boolean;
  includeRisk?: boolean;
  limit?: number;
  maxEdgesPerNode?: number;
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
  truncatedNodes?: string[];
  /** Git problems (not a repository, unknown base) when files were not given explicitly. */
  warnings?: string[];
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

/**
 * Normalizes a node: lower-case type, legacy class-like types (`parent_class`, `interface`,
 * `trait`) folded into `class`, slash-normalized file/template names and PHP names (class,
 * method, function, ORM entity) without a leading backslash. The display case of names is kept;
 * use {@link graphNodeKey} to compare nodes.
 */
export function normalizeGraphNode(type: string, name: string): GraphNode {
  const normalizedType = canonicalGraphNodeType(type);
  const trimmed = name.trim();
  const normalizedName = normalizedType === "file" || normalizedType === "template"
    ? normalizeSlashes(trimmed)
    : isCaseInsensitiveNodeType(normalizedType) ? trimmed.replace(/^\\+/u, "") : trimmed;
  if (!normalizedType || !normalizedName) {
    throw new Error("Graph node type and name must not be empty.");
  }
  return { id: `${normalizedType}:${normalizedName}`, type: normalizedType, name: normalizedName };
}

/** Identity of a node: PHP class/method/function/ORM entity names are compared case-insensitively. */
export function graphNodeKey(node: Pick<GraphNode, "type" | "name">): string {
  return isCaseInsensitiveNodeType(node.type) ? `${node.type}:${phpNameKey(node.name)}` : `${node.type}:${node.name}`;
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
  return normalizeStoredRelation({
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
  });
}

function relationToEdge(relation: BitrixRelationRecord, source: GraphNode, target: GraphNode): GraphEdge {
  return {
    source: source.id,
    target: target.id,
    sourceType: source.type,
    sourceName: source.name,
    targetType: target.type,
    targetName: target.name,
    relationType: relation.relationType,
    file: normalizeSlashes(relation.file),
    line: relation.line,
    module: relation.module,
    kind: relation.kind,
    signature: relation.signature,
    metadata: relation.metadata
  };
}

function applyFormatToEdge(edge: GraphEdge, format: GraphFormat | undefined): GraphEdge {
  if (format === "full") return edge;
  const { source, target, sourceType, sourceName, targetType, targetName, relationType, file, line, module, kind } = edge;
  return { source, target, sourceType, sourceName, targetType, targetName, relationType, file, line, module, kind };
}

function edgeKey(sourceKey: string, relationType: string, targetKey: string, file: string, line: number): string {
  return `${sourceKey}->${relationType}->${targetKey}:${file}:${line}`;
}

/** Opens the index read-only; undefined when no index exists yet. The caller closes it. */
async function openGraphDatabase(dbFile: string): Promise<DatabaseSync | undefined> {
  try {
    await fs.access(dbFile);
  } catch {
    return undefined;
  }
  await ensureSqliteStore(dbFile);
  return openDatabase(dbFile, { readOnly: true });
}

interface FrontierEdges {
  /** Edges per frontier node key, outgoing first, each list in id order. */
  byNode: Map<string, Array<{ relation: BitrixRelationRecord; direction: "out" | "in" }>>;
  /** Frontier node keys that had more than `perNodeCap` edges in one direction. */
  capped: Set<string>;
}

/**
 * Reads the edges of a whole BFS level: one query per node type, direction and chunk of
 * `FRONTIER_CHUNK` names. `ROW_NUMBER()` caps the rows per node (`perNodeCap + 1` are read to
 * detect the cut), so a hub node such as `module:iblock` never materializes thousands of rows.
 */
function readFrontierEdges(db: DatabaseSync, frontier: GraphNode[], direction: GraphDirection, relationTypes: string[], perNodeCap: number): FrontierEdges {
  const byNode = new Map<string, Array<{ relation: BitrixRelationRecord; direction: "out" | "in" }>>();
  const capped = new Set<string>();
  const byType = new Map<string, GraphNode[]>();
  for (const node of frontier) {
    const group = byType.get(node.type) ?? [];
    group.push(node);
    byType.set(node.type, group);
  }
  const relationFilter = relationTypes.length > 0 ? ` AND relation_type IN (${relationTypes.map(() => "?").join(", ")})` : "";
  const directions: Array<"out" | "in"> = direction === "both" ? ["out", "in"] : [direction];

  for (const edgeDirection of directions) {
    const typeColumn = edgeDirection === "out" ? "source_type" : "target_type";
    const nameColumn = edgeDirection === "out" ? "source_name" : "target_name";
    for (const [type, nodes] of byType) {
      const storedTypes = storedGraphNodeTypes(type);
      const caseInsensitive = isCaseInsensitiveNodeType(type);
      // Case-insensitive names are matched with COLLATE NOCASE, with and without a leading backslash.
      const names = [...new Set(nodes.flatMap((node) => caseInsensitive ? [node.name, `\\${node.name}`] : [node.name]))];
      const nameMatch = caseInsensitive ? `${nameColumn} COLLATE NOCASE` : nameColumn;
      const partition = caseInsensitive ? `lower(ltrim(${nameColumn}, char(92)))` : nameColumn;
      for (let index = 0; index < names.length; index += FRONTIER_CHUNK) {
        const chunk = names.slice(index, index + FRONTIER_CHUNK);
        const rows = db.prepare(`
          SELECT ${RELATION_COLUMNS}, rn FROM (
            SELECT ${RELATION_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY id) AS rn
            FROM bitrix_relations
            WHERE ${typeColumn} IN (${storedTypes.map(() => "?").join(", ")}) AND ${nameMatch} IN (${chunk.map(() => "?").join(", ")})${relationFilter}
          )
          WHERE rn <= ?
          ORDER BY id ASC
        `).all(...storedTypes, ...chunk, ...relationTypes, perNodeCap + 1) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const relation = rowToRelation(row);
          const endpoint = edgeDirection === "out"
            ? normalizeGraphNode(relation.sourceType, relation.sourceName)
            : normalizeGraphNode(relation.targetType, relation.targetName);
          const key = graphNodeKey(endpoint);
          if (Number(row.rn) > perNodeCap) {
            capped.add(key);
            continue;
          }
          const list = byNode.get(key) ?? [];
          list.push({ relation, direction: edgeDirection });
          byNode.set(key, list);
        }
      }
    }
  }
  return { byNode, capped };
}

interface TraversalOptions {
  direction: GraphDirection;
  maxDepth: number;
  relationTypes: string[];
  limit: number;
  maxEdgesPerNode: number;
  format?: GraphFormat;
}

interface TraversalResult {
  nodes: GraphTraverseNode[];
  edges: GraphEdge[];
  truncated: boolean;
  truncatedNodes: string[];
}

/**
 * Multi-source BFS over `bitrix_relations` on one connection, one batched read per level.
 * Cycle-safe (every node is expanded at most once, at its shortest depth) and bounded by
 * `maxDepth`, `limit` (nodes and edges) and `maxEdgesPerNode`. Edge endpoints reuse the id of
 * the node already in the result, so nodes that differ only in PHP name case are merged.
 */
function traverseFromNodes(db: DatabaseSync | undefined, starts: GraphNode[], options: TraversalOptions): TraversalResult {
  const nodes = new Map<string, GraphTraverseNode>();
  let frontier: GraphTraverseNode[] = [];
  for (const start of starts) {
    const key = graphNodeKey(start);
    if (nodes.has(key)) continue;
    const node = { ...start, depth: 0 };
    nodes.set(key, node);
    frontier.push(node);
  }
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const truncatedNodes = new Set<string>();
  const finish = (truncated: boolean): TraversalResult => ({
    nodes: [...nodes.values()].slice(0, options.limit),
    edges: edges.slice(0, options.limit),
    truncated: truncated || truncatedNodes.size > 0,
    truncatedNodes: [...truncatedNodes]
  });
  if (!db) return finish(false);

  for (let depth = 0; depth < options.maxDepth && frontier.length > 0; depth += 1) {
    const { byNode, capped } = readFrontierEdges(db, frontier, options.direction, options.relationTypes, options.maxEdgesPerNode);
    const next: GraphTraverseNode[] = [];
    for (const current of frontier) {
      const currentKey = graphNodeKey(current);
      if (capped.has(currentKey)) truncatedNodes.add(current.id);
      for (const { relation, direction } of byNode.get(currentKey) ?? []) {
        const rawNext = direction === "out" ? normalizeGraphNode(relation.targetType, relation.targetName) : normalizeGraphNode(relation.sourceType, relation.sourceName);
        const nextKey = graphNodeKey(rawNext);
        let nextNode = nodes.get(nextKey);
        if (!nextNode) {
          nextNode = { ...rawNext, depth: depth + 1 };
          nodes.set(nextKey, nextNode);
          next.push(nextNode);
        }
        const [source, target, sourceKey, targetKey] = direction === "out" ? [current, nextNode, currentKey, nextKey] : [nextNode, current, nextKey, currentKey];
        const key = edgeKey(sourceKey, relation.relationType, targetKey, normalizeSlashes(relation.file), relation.line);
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          edges.push(applyFormatToEdge(relationToEdge(relation, source, target), options.format));
        }
        if (nodes.size > options.limit || edges.length > options.limit) {
          return finish(true);
        }
      }
    }
    frontier = next;
  }
  return finish(false);
}

function traversalOptions(options: GraphTraverseOptions & { maxDepthDefault: number; maxDepthMax: number; maxDepthMin: number }): TraversalOptions {
  const limit = clampInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return {
    direction: options.direction ?? "out",
    maxDepth: clampInteger(options.maxDepth, options.maxDepthDefault, options.maxDepthMin, options.maxDepthMax),
    relationTypes: options.relationTypes ?? [],
    limit,
    maxEdgesPerNode: clampInteger(options.maxEdgesPerNode, limit, 1, MAX_LIMIT),
    format: options.format
  };
}

async function withGraphDatabase<T>(dbFile: string, run: (db: DatabaseSync | undefined) => T): Promise<T> {
  const db = await openGraphDatabase(dbFile);
  try {
    return run(db);
  } finally {
    db?.close();
  }
}

export async function getGraphNeighbors(dbFile: string, nodeInput: { type: string; name: string }, options: GraphNeighborsOptions = {}): Promise<GraphNeighborsResult> {
  const node = normalizeGraphNode(nodeInput.type, nodeInput.name);
  const resolved = traversalOptions({
    direction: options.direction ?? "out",
    maxDepth: options.depth,
    relationTypes: options.relationType ? [options.relationType] : [],
    limit: options.limit,
    maxEdgesPerNode: options.maxEdgesPerNode,
    format: options.format,
    maxDepthDefault: DEFAULT_NEIGHBOR_DEPTH,
    maxDepthMin: 1,
    maxDepthMax: MAX_NEIGHBOR_DEPTH
  });
  const traverse = await withGraphDatabase(dbFile, (db) => traverseFromNodes(db, [node], resolved));
  const nodesById = new Map(traverse.nodes.map((candidate) => [candidate.id, candidate]));
  const neighbors: GraphNeighbor[] = [];
  for (const edge of traverse.edges) {
    const edgeDirection: "out" | "in" = edge.source === node.id ? "out" : "in";
    const neighborId = edgeDirection === "out" ? edge.target : edge.source;
    const neighborNode = nodesById.get(neighborId) ?? { ...parseGraphNodeId(neighborId), depth: 1 };
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
  return {
    node: { type: node.type, name: node.name },
    neighbors: neighbors.slice(0, resolved.limit),
    truncated: traverse.truncated || neighbors.length > resolved.limit,
    ...(traverse.truncatedNodes.length > 0 ? { truncatedNodes: traverse.truncatedNodes } : {})
  };
}

export async function traverseGraph(dbFile: string, startNode: { type: string; name: string }, options: GraphTraverseOptions = {}): Promise<GraphTraverseResult> {
  const start = normalizeGraphNode(startNode.type, startNode.name);
  const resolved = traversalOptions({ ...options, maxDepthDefault: DEFAULT_TRAVERSE_DEPTH, maxDepthMin: 0, maxDepthMax: MAX_TRAVERSE_DEPTH });
  const result = await withGraphDatabase(dbFile, (db) => traverseFromNodes(db, [start], resolved));
  return {
    start: { type: start.type, name: start.name },
    nodes: result.nodes,
    edges: result.edges,
    truncated: result.truncated,
    ...(result.truncatedNodes.length > 0 ? { truncatedNodes: result.truncatedNodes } : {})
  };
}

/**
 * Graph node of an indexed symbol. Classes, interfaces and traits all map to `class:<FQN>`
 * (the node inheritance edges point at); methods use `method:<Class>::<method>`.
 */
export function symbolToNode(symbol: SymbolRecord): GraphNode | undefined {
  switch (symbol.type) {
    case "class":
    case "interface":
    case "trait":
      return normalizeGraphNode("class", symbol.fullyQualifiedName ?? symbol.name);
    case "method": {
      const name = symbol.fullyQualifiedName ?? (symbol.className ? `${symbol.className}::${symbol.name}` : symbol.name);
      return normalizeGraphNode("method", name);
    }
    case "event":
      if (symbol.module && symbol.eventName) return normalizeGraphNode("event", `${symbol.module}:${symbol.eventName}`);
      return normalizeGraphNode("event", symbol.name);
    case "function":
    case "component":
    case "agent":
    case "mail_event":
      return normalizeGraphNode(symbol.type, symbol.fullyQualifiedName ?? symbol.name);
    default:
      return undefined;
  }
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

/**
 * Impact radius of changed files: start nodes are the files, the endpoints of their relations and
 * (by default) the graph nodes of their indexed symbols. All start nodes are expanded together in
 * one multi-source BFS on a single connection, which yields the same nodes/edges as one traversal
 * per start node at a fraction of the cost.
 */
export async function getImpactRadius(dbFile: string, options: ImpactRadiusOptions = {}): Promise<ImpactRadiusResult> {
  const base = validateGitBase(options.base);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const warnings: string[] = [];
  let sourceFiles = options.files ?? [];
  if (sourceFiles.length === 0) {
    try {
      const changes = await gitChangedFileEntries(workspaceRoot, base);
      sourceFiles = changes.files.map((change) => change.file);
      warnings.push(...changes.warnings);
    } catch (error) {
      warnings.push(gitUnavailableWarning(error, base));
    }
  }
  const changedFiles = [...new Set(sourceFiles.map((file) => normalizeSlashes(file)))].slice(0, MAX_LIMIT);
  const fileCandidates = changedFiles.flatMap((file) => [file, path.resolve(workspaceRoot, file)]);
  const indexed = await readIndexedRecordsForFiles(dbFile, fileCandidates, { includeRelations: true });
  const startNodes = new Map<string, GraphNode>();
  const addStart = (node: GraphNode | undefined): void => {
    if (!node) return;
    const key = graphNodeKey(node);
    if (!startNodes.has(key)) startNodes.set(key, node);
  };

  for (const file of changedFiles) addStart(normalizeGraphNode("file", file));
  for (const relation of indexed.relations) {
    const normalized = normalizeStoredRelation(relation);
    addStart(normalizeGraphNode(normalized.sourceType, normalized.sourceName));
    addStart(normalizeGraphNode(normalized.targetType, normalized.targetName));
  }
  if (options.includeChangedSymbols !== false) {
    for (const symbol of indexed.symbols) addStart(symbolToNode(symbol));
  }

  const resolved = traversalOptions({
    direction: "both",
    maxDepth: options.maxDepth,
    relationTypes: options.relationTypes,
    limit: options.limit,
    maxEdgesPerNode: options.maxEdgesPerNode,
    format: options.format,
    maxDepthDefault: DEFAULT_TRAVERSE_DEPTH,
    maxDepthMin: 0,
    maxDepthMax: MAX_TRAVERSE_DEPTH
  });
  const traversal = await withGraphDatabase(dbFile, (db) => traverseFromNodes(db, [...startNodes.values()], resolved));

  const impacted = impactedGroups();
  for (const node of traversal.nodes) addImpactedNode(impacted, node);
  return {
    base,
    changedFiles,
    startNodes: [...startNodes.values()].map((node) => ({ ...node, depth: 0 })).slice(0, resolved.limit),
    impacted,
    edges: traversal.edges,
    risk: options.includeRisk === false ? { score: 0, level: "low", reasons: [] } : scoreImpactRisk(traversal.edges),
    truncated: traversal.truncated || startNodes.size > resolved.limit,
    ...(traversal.truncatedNodes.length > 0 ? { truncatedNodes: traversal.truncatedNodes } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export async function getImpactRadiusForPaths(paths: RuntimePaths, options: ImpactRadiusOptions = {}): Promise<ImpactRadiusResult> {
  return getImpactRadius(sqlitePath(paths.dataDir), { ...options, workspaceRoot: paths.workspaceRoot });
}
