import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { readIndexedRecordsForFiles, type IndexedRecordsForFiles } from "./sqliteStore.js";
import { getImpactRadiusForPaths, type ImpactRadiusResult } from "./graph.js";
import { gitChangedFileEntries, gitShowFileAtBase, gitUnavailableWarning, validateGitBase, type GitChangedFile, type GitFileStatus } from "./gitChanges.js";
import { detectLanguage } from "./language.js";
import { parseFile } from "./parseFile.js";
import { phpNameKey } from "./store/relations.js";
import type { BitrixRelationRecord, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OptionUsageRecord, OrmEntityRecord, OrmUsageRecord, SymbolRecord } from "../types.js";

export { validateGitBase } from "./gitChanges.js";

export type ChangedFileKind = "project" | "template" | "component" | "bitrix" | "install" | "docs" | "asset" | "unknown";
export type ChangedFileStatus = GitFileStatus;
export type RiskLevel = "low" | "medium" | "high";
export type DetectChangesFormat = "compact" | "full";
/**
 * Where the "before" symbols of the symbol diff come from:
 * - `index`: the SQLite index (the before state when the index is older than the working tree);
 * - `git`: a fresh parse of the file at the git base;
 * - `auto` (default): `index` for files whose index row is stale (size/mtime differ from the
 *   working tree, or the file is deleted but still indexed), otherwise `git`.
 */
export type SymbolDiffBaselineMode = "auto" | "index" | "git";
export type SymbolDiffBaseline = "index" | "git" | "none";

export interface DetectChangesOptions {
  base?: string;
  kind?: string | string[];
  includeSource?: boolean;
  includeRelations?: boolean;
  includeImpact?: boolean;
  includeRisk?: boolean;
  /** Symbol-level diff of changed PHP/JS/TS files (added / removed / changed symbols); enabled by default. */
  symbolDiff?: boolean;
  diffBaseline?: SymbolDiffBaselineMode;
  maxDepth?: number;
  maxFiles?: number;
  maxItems?: number;
  format?: DetectChangesFormat;
}

export interface ChangedFileInfo {
  file: string;
  kind: ChangedFileKind;
  status?: ChangedFileStatus;
  absolutePath?: string;
}

export interface ChangeRisk {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export interface SymbolDiffEntry {
  type: string;
  name: string;
  line: number;
  lineEnd?: number;
  signature?: string;
}

export interface SymbolDiffChange {
  type: string;
  name: string;
  reasons: Array<"signature" | "span">;
  before: Omit<SymbolDiffEntry, "type" | "name">;
  after: Omit<SymbolDiffEntry, "type" | "name">;
}

export interface FileSymbolDiff {
  file: string;
  status?: ChangedFileStatus;
  baseline: SymbolDiffBaseline;
  added: SymbolDiffEntry[];
  removed: SymbolDiffEntry[];
  changed: SymbolDiffChange[];
  warning?: string;
}

export interface SymbolDiffResult {
  files: FileSymbolDiff[];
  totals: { files: number; added: number; removed: number; changed: number };
  /** Files whose "before" state came from a stale index row: the index is older than the working tree. */
  staleIndexFiles: number;
  truncated: boolean;
}

export interface DeletedFileInfo {
  file: string;
  kind: ChangedFileKind;
  /** Where the listed symbols come from: the index (file still indexed) or a parse of the git base. */
  source: "index" | "git" | "none";
  symbolCount: number;
  symbols: unknown[];
}

export interface DetectChangesResult {
  base: string;
  changedFiles: ChangedFileInfo[];
  summary: {
    files: number;
    symbols: number;
    events: number;
    moduleUsages: number;
    agents: number;
    mailEvents: number;
    components: number;
    ormEntities: number;
    ormUsages: number;
    iblockUsages: number;
    hlblockUsages: number;
    options: number;
    relations: number;
    deletedFiles: number;
    untrackedFiles: number;
    symbolsAdded: number;
    symbolsRemoved: number;
    symbolsChanged: number;
  };
  changedSymbols: unknown[];
  changedEvents: unknown[];
  changedModuleUsages: unknown[];
  changedAgents: unknown[];
  changedMailEvents: unknown[];
  changedComponents: unknown[];
  changedOrmEntities: unknown[];
  changedOrmUsages: unknown[];
  changedIblockUsages: unknown[];
  changedHlblockUsages: unknown[];
  changedOptions: unknown[];
  relatedRelations: unknown[];
  deletedFiles: DeletedFileInfo[];
  symbolDiff?: SymbolDiffResult;
  impact?: DetectChangesImpact;
  risk: ChangeRisk;
  recommendations: string[];
  warnings?: string[];
}

export type DetectChangesImpact = Pick<ImpactRadiusResult, "startNodes" | "impacted" | "edges" | "truncated">;

function emptyImpact(): DetectChangesImpact {
  return {
    startNodes: [],
    impacted: { events: [], handlers: [], components: [], templates: [], ormEntities: [], agents: [], mailEvents: [], iblocks: [], hlblocks: [], modules: [], options: [], classes: [], methods: [] },
    edges: [],
    truncated: false
  };
}

function compactImpact(impact: ImpactRadiusResult, maxItems: number): DetectChangesImpact {
  return {
    startNodes: limitItems(impact.startNodes, maxItems),
    impacted: Object.fromEntries(Object.entries(impact.impacted).map(([key, value]) => [key, limitItems(value, maxItems)])) as ImpactRadiusResult["impacted"],
    edges: limitItems(impact.edges, maxItems),
    truncated: impact.truncated
  };
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

/** Changed file names (see {@link gitChangedFileEntries}); throws when git fails. */
export async function gitChangedFiles(workspaceRoot: string, base?: string): Promise<string[]> {
  return (await gitChangedFileEntries(workspaceRoot, base)).files.map((change) => change.file);
}

async function gitChangedFilesOrWarning(workspaceRoot: string, base: string): Promise<{ files: GitChangedFile[]; warnings: string[] }> {
  try {
    return await gitChangedFileEntries(workspaceRoot, base);
  } catch (error) {
    return { files: [], warnings: [gitUnavailableWarning(error, base)] };
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveChangedFile(workspaceRoot: string, file: string): ChangedFileInfo {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedFile = normalizeSlashes(file).replace(/^\.\//u, "");
  if (path.isAbsolute(normalizedFile) || normalizedFile.split("/").includes("..")) {
    throw new Error(`Unsafe changed file path from git diff: ${file}`);
  }
  const absolutePath = path.resolve(normalizedRoot, normalizedFile);
  if (!isInside(normalizedRoot, absolutePath)) {
    throw new Error(`Changed file resolves outside workspace: ${file}`);
  }
  return { file: normalizedFile, kind: detectChangedFileKind(normalizedFile), absolutePath };
}

export function detectChangedFileKind(file: string): ChangedFileKind {
  const normalized = normalizeSlashes(file).toLowerCase();
  const basename = path.posix.basename(normalized);
  const ext = path.posix.extname(normalized);

  if (normalized.startsWith("docs/") || [".md", ".mdx", ".rst", ".txt"].includes(ext)) return "docs";
  // Module installers (including bitrix/modules/*/install/*) are "install", not core "bitrix".
  if (normalized.includes("/install/") || normalized.startsWith("install/")) return "install";
  if (normalized.startsWith("bitrix/modules/")) return "bitrix";
  if (normalized.includes("/components/") || /(^|\/)component(_epilog)?\.php$/u.test(normalized) || ["template.php", "result_modifier.php"].includes(basename)) return "component";
  if (normalized.startsWith("local/templates/") || normalized.startsWith("bitrix/templates/")) return "template";
  if ([".css", ".scss", ".sass", ".less", ".js", ".ts", ".tsx", ".jsx", ".vue", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2"].includes(ext)) return "asset";
  if (normalized.startsWith("local/") || normalized.endsWith(".php")) return "project";
  return "unknown";
}

function compactSymbol(symbol: SymbolRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ type: symbol.type, kind: symbol.kind, name: symbol.name, fullyQualifiedName: symbol.fullyQualifiedName !== symbol.name ? symbol.fullyQualifiedName : undefined, module: symbol.module, eventName: symbol.eventName, file: symbol.relativeFile ?? symbol.file, line: symbol.line, signature: includeSource ? symbol.signature : undefined });
}

function compactModuleUsage(usage: ModuleUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ module: usage.module, call: usage.call, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, signature: includeSource ? usage.signature : undefined });
}

function compactComponent(symbol: SymbolRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ name: symbol.name, template: symbol.template, kind: symbol.kind, file: symbol.relativeFile ?? symbol.file, line: symbol.line, params: symbol.params ?? [], signature: includeSource ? symbol.signature : undefined });
}

function compactOrmEntity(entity: OrmEntityRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ className: entity.fullyQualifiedName || entity.className, tableName: entity.tableName, kind: entity.kind, file: entity.relativeFile ?? entity.file, line: entity.line, signature: includeSource ? entity.signature : undefined });
}

function compactOrmUsage(usage: OrmUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ entity: usage.entity, method: usage.method, usageKind: usage.usageKind, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, signature: includeSource ? usage.signature : undefined });
}

function compactIblockUsage(usage: IblockUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ iblockId: usage.iblockId, api: usage.api, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, component: usage.component, signature: includeSource ? usage.signature : undefined });
}

function compactHlblockUsage(usage: HlblockUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ hlblockId: usage.hlblockId, api: usage.api, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, signature: includeSource ? usage.signature : undefined });
}

function compactOptionUsage(usage: OptionUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ module: usage.module, name: usage.name, operation: usage.operation, api: usage.api, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, signature: includeSource ? usage.signature : undefined });
}

function compactRelation(relation: BitrixRelationRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ source: `${relation.sourceType}:${relation.sourceName}`, target: `${relation.targetType}:${relation.targetName}`, relationType: relation.relationType, module: relation.module, kind: relation.kind, file: relation.file, line: relation.line, signature: includeSource ? relation.signature : undefined });
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function limitItems<T>(items: T[], maxItems: number): T[] {
  return items.slice(0, maxItems);
}

function includesKind(kind: DetectChangesOptions["kind"], fileKind: ChangedFileKind): boolean {
  if (kind === undefined) return true;
  const kinds = Array.isArray(kind) ? kind : [kind];
  return kinds.includes(fileKind);
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function scoreChangeRisk(input: {
  changedFiles: ChangedFileInfo[];
  changedEvents: SymbolRecord[];
  changedAgents: SymbolRecord[];
  changedMailEvents: SymbolRecord[];
  relatedRelations: BitrixRelationRecord[];
  impactRisk?: ChangeRisk;
  /** Deleted files that still had symbols (in the index or at the git base). */
  deletedFilesWithSymbols?: number;
  /** Symbols removed according to the symbol diff. */
  removedSymbols?: number;
  /** Symbols whose signature changed according to the symbol diff. */
  signatureChanges?: number;
}): ChangeRisk {
  let score = 0;
  const reasons: string[] = [];
  const files = input.changedFiles.map((changed) => changed.file.toLowerCase());

  for (const file of files) {
    if (file === "local/php_interface/init.php") { score += 45; addReason(reasons, "changed local/php_interface/init.php"); }
    if (/^(local|bitrix)\/modules\/[^/]+\/install\/index\.php$/u.test(file)) { score += 45; addReason(reasons, "changed module install/index.php"); }
    if (file.includes("/bitrix/modules/") || file.startsWith("bitrix/modules/")) { score += 45; addReason(reasons, "changed bitrix/modules files"); }
    // TODO: add explicit ORM getMap risk once an ORM parser records method-level getMap changes.
    if (/(^|\/)template\.php$/u.test(file)) { score += 18; addReason(reasons, "changed template.php"); }
    if (/(^|\/)result_modifier\.php$/u.test(file)) { score += 18; addReason(reasons, "changed result_modifier.php"); }
    if (/(^|\/)component_epilog\.php$/u.test(file)) { score += 18; addReason(reasons, "changed component_epilog.php"); }
    if (file.includes("/install/") && /\.(js|ts|jsx|tsx)$/u.test(file)) { score += 18; addReason(reasons, "changed JS install asset"); }
    if (/\.(css|scss|sass|less)$/u.test(file)) { addReason(reasons, "style-only change candidate"); }
    if (file.startsWith("docs/") || /\.(md|mdx|rst|txt)$/u.test(file)) { addReason(reasons, "docs-only change candidate"); }
    if (file.includes("/components/") && /(catalog|order|basket)/u.test(file)) { score += 45; addReason(reasons, "changed component files for catalog/order/basket"); }
  }

  for (const event of input.changedEvents) {
    if (["main", "sale", "catalog"].includes((event.module ?? "").toLowerCase())) { score += 45; addReason(reasons, "changed event handler for main/sale/catalog"); }
  }
  if (input.changedAgents.length > 0) { score += 45; addReason(reasons, "changed agent"); }
  if (input.changedMailEvents.length > 0) { score += 45; addReason(reasons, "changed mail event handler"); }
  if (input.relatedRelations.some((relation) => relation.relationType.includes("event") || relation.sourceType === "event" || relation.targetType === "event")) {
    score += 18; addReason(reasons, "changed service class used by event handler");
  }
  if ((input.deletedFilesWithSymbols ?? 0) > 0) { score += 18; addReason(reasons, "deleted files that declared symbols"); }
  if ((input.removedSymbols ?? 0) > 0) { score += 18; addReason(reasons, "removed symbols (possible breaking change)"); }
  if ((input.signatureChanges ?? 0) > 0) { score += 8; addReason(reasons, "changed symbol signatures"); }
  if (input.impactRisk) {
    score += input.impactRisk.score;
    for (const reason of input.impactRisk.reasons) addReason(reasons, reason);
  }
  if (input.relatedRelations.length === 0 && score === 0 && input.changedFiles.length > 0) {
    addReason(reasons, "isolated helper without relations");
  }

  const capped = Math.max(0, Math.min(100, score));
  return { score: capped, level: capped >= 40 ? "high" : capped >= 15 ? "medium" : "low", reasons };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function recommendationsForChange(input: {
  risk: ChangeRisk;
  changedComponents: SymbolRecord[];
  changedOrmEntities: OrmEntityRecord[];
  changedOrmUsages: OrmUsageRecord[];
  changedIblockUsages: IblockUsageRecord[];
  changedHlblockUsages: HlblockUsageRecord[];
  changedOptions: OptionUsageRecord[];
  impact?: DetectChangesImpact;
  symbolDiff?: SymbolDiffResult;
  deletedFiles?: DeletedFileInfo[];
}): string[] {
  const recommendations: string[] = [];
  if (input.risk.level === "high") {
    recommendations.push("Review changed Bitrix hooks/install/core files manually before deploy.", "Run focused regression checks for affected modules, events, agents, mail events, and components.");
  } else if (input.risk.level === "medium") {
    recommendations.push("Review affected templates/assets and smoke-test related UI flows.");
  } else {
    recommendations.push("Run standard tests and verify the changed files are indexed if analysis looks incomplete.");
  }
  if (input.changedOrmEntities.length > 0 || input.changedOrmUsages.length > 0) recommendations.push("Check ORM getMap, table fields, references, filters, and migrations.");
  if (input.changedComponents.length > 0) recommendations.push("Check component params, cache, template rendering, and related assets.");
  if (input.changedIblockUsages.length > 0) recommendations.push("Check IBLOCK_ID, property filters, selected fields, and permissions.");
  if (input.changedHlblockUsages.length > 0) recommendations.push("Check highloadblock ID/code, compiled entity map, and query filters.");
  if (input.changedOptions.length > 0) recommendations.push("Check option module/name defaults and configuration migration.");
  if ((input.impact?.impacted.mailEvents.length ?? 0) > 0) recommendations.push("Check event fields and email templates.");
  if ((input.impact?.impacted.agents.length ?? 0) > 0) recommendations.push("Check agent registration, interval, and callable availability.");
  const removed = input.symbolDiff?.totals.removed ?? 0;
  const resigned = input.symbolDiff?.files.some((file) => (file.changed ?? []).some((change) => change.reasons.includes("signature"))) ?? false;
  if (removed > 0 || resigned || (input.deletedFiles?.some((file) => file.symbolCount > 0) ?? false)) {
    recommendations.push("Find callers of removed, deleted, or re-signed symbols (bitrix_graph_neighbors with direction \"in\", bitrix_liveapi_search) before merging.");
  }
  if ((input.symbolDiff?.staleIndexFiles ?? 0) > 0) {
    recommendations.push("The index is older than the working tree for some changed files; re-run indexing after review so graph data matches the code.");
  }
  return unique(recommendations);
}

const DIFFABLE_LANGUAGES = new Set(["php", "javascript", "typescript"]);
const CASE_INSENSITIVE_SYMBOL_TYPES = new Set(["class", "interface", "trait", "function", "method"]);
/** Files larger than this are not re-parsed for the symbol diff. */
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_SIGNATURE_CHARS = 240;

function isCallSiteSymbol(symbol: SymbolRecord): boolean {
  return symbol.type === "static_call" || symbol.type === "method_call";
}

function diffSymbolName(symbol: SymbolRecord): string {
  if (symbol.type === "method") return symbol.fullyQualifiedName ?? (symbol.className ? `${symbol.className}::${symbol.name}` : symbol.name);
  if (symbol.type === "event") {
    const event = symbol.module && symbol.eventName ? `${symbol.module}:${symbol.eventName}` : symbol.name;
    const handler = symbol.handlerClass && symbol.handlerMethod ? `${symbol.handlerClass}::${symbol.handlerMethod}` : symbol.handlerFunction;
    return handler ? `${event} -> ${handler}` : event;
  }
  if (symbol.type === "component") return symbol.template ? `${symbol.name}:${symbol.template}` : symbol.name;
  return symbol.fullyQualifiedName ?? symbol.name;
}

function diffSymbolKey(symbol: SymbolRecord): string {
  const name = diffSymbolName(symbol);
  return `${symbol.type}|${CASE_INSENSITIVE_SYMBOL_TYPES.has(symbol.type) ? phpNameKey(name) : name}`;
}

function normalizedSignature(signature: string | undefined): string {
  return (signature ?? "").replace(/\s+/gu, " ").trim();
}

function shortSignature(signature: string | undefined): string | undefined {
  const normalized = normalizedSignature(signature);
  if (!normalized) return undefined;
  return normalized.length > MAX_DIFF_SIGNATURE_CHARS ? `${normalized.slice(0, MAX_DIFF_SIGNATURE_CHARS)}…` : normalized;
}

function lineSpan(symbol: SymbolRecord): number | undefined {
  return symbol.lineEnd !== undefined && symbol.lineEnd >= symbol.line ? symbol.lineEnd - symbol.line : undefined;
}

function diffEntry(symbol: SymbolRecord, includeSignature: boolean): SymbolDiffEntry {
  return compact({ type: symbol.type, name: diffSymbolName(symbol), line: symbol.line, lineEnd: symbol.lineEnd, signature: includeSignature ? shortSignature(symbol.signature) : undefined }) as unknown as SymbolDiffEntry;
}

function diffPosition(symbol: SymbolRecord, includeSignature: boolean): Omit<SymbolDiffEntry, "type" | "name"> {
  return compact({ line: symbol.line, lineEnd: symbol.lineEnd, signature: includeSignature ? shortSignature(symbol.signature) : undefined }) as unknown as Omit<SymbolDiffEntry, "type" | "name">;
}

/**
 * Symbol-level diff of one file. Symbols are keyed by type and qualified name (PHP names
 * case-insensitively); repeated keys (e.g. two handlers for one event) are paired in source order.
 * A pair is `changed` when its whitespace-normalized signature differs or its line span
 * (`lineEnd - line`) differs; a symbol that merely moved is not reported.
 */
export function diffSymbols(before: SymbolRecord[], after: SymbolRecord[], options: { includeSignature?: boolean } = {}): Pick<FileSymbolDiff, "added" | "removed" | "changed"> {
  const includeSignature = options.includeSignature === true;
  const group = (symbols: SymbolRecord[]): Map<string, SymbolRecord[]> => {
    const groups = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      if (isCallSiteSymbol(symbol)) continue;
      const key = diffSymbolKey(symbol);
      const list = groups.get(key) ?? [];
      list.push(symbol);
      groups.set(key, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.line - b.line);
    return groups;
  };
  const beforeGroups = group(before);
  const afterGroups = group(after);
  const added: SymbolDiffEntry[] = [];
  const removed: SymbolDiffEntry[] = [];
  const changed: SymbolDiffChange[] = [];

  for (const [key, afterList] of afterGroups) {
    const beforeList = beforeGroups.get(key) ?? [];
    afterList.forEach((afterSymbol, index) => {
      const beforeSymbol = beforeList[index];
      if (!beforeSymbol) {
        added.push(diffEntry(afterSymbol, includeSignature));
        return;
      }
      const reasons: SymbolDiffChange["reasons"] = [];
      if (normalizedSignature(beforeSymbol.signature) !== normalizedSignature(afterSymbol.signature)) reasons.push("signature");
      const beforeSpan = lineSpan(beforeSymbol);
      const afterSpan = lineSpan(afterSymbol);
      if (beforeSpan !== undefined && afterSpan !== undefined && beforeSpan !== afterSpan) reasons.push("span");
      if (reasons.length > 0) {
        const showSignature = includeSignature || reasons.includes("signature");
        changed.push({ type: afterSymbol.type, name: diffSymbolName(afterSymbol), reasons, before: diffPosition(beforeSymbol, showSignature), after: diffPosition(afterSymbol, showSignature) });
      }
    });
  }
  for (const [key, beforeList] of beforeGroups) {
    const afterCount = afterGroups.get(key)?.length ?? 0;
    for (const beforeSymbol of beforeList.slice(afterCount)) removed.push(diffEntry(beforeSymbol, includeSignature));
  }
  const byLine = (a: { line?: number; after?: { line: number } }, b: { line?: number; after?: { line: number } }): number => (a.line ?? a.after?.line ?? 0) - (b.line ?? b.after?.line ?? 0);
  return { added: added.sort(byLine), removed: removed.sort(byLine), changed: changed.sort(byLine) };
}

function symbolsForChangedFile(indexed: IndexedRecordsForFiles, change: ChangedFileInfo): SymbolRecord[] {
  const absolute = change.absolutePath ? normalizeSlashes(change.absolutePath) : undefined;
  return indexed.symbols.filter((symbol) => !isCallSiteSymbol(symbol) && (normalizeSlashes(symbol.relativeFile ?? "") === change.file || (absolute !== undefined && normalizeSlashes(symbol.file) === absolute)));
}

function indexedFileFor(indexed: IndexedRecordsForFiles, change: ChangedFileInfo): IndexedRecordsForFiles["files"][number] | undefined {
  const absolute = change.absolutePath ? normalizeSlashes(change.absolutePath) : undefined;
  return indexed.files.find((file) => file.path === absolute) ?? indexed.files.find((file) => file.relativePath === change.file);
}

async function statOrUndefined(file: string | undefined): Promise<{ size: number; mtimeMs: number } | undefined> {
  if (!file) return undefined;
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

interface SymbolDiffContext {
  workspaceRoot: string;
  base: string;
  mode: SymbolDiffBaselineMode;
  includeSignature: boolean;
  tempDir?: string;
}

async function parseAtBase(context: SymbolDiffContext, change: ChangedFileInfo, language: string, index: number): Promise<{ symbols: SymbolRecord[]; found: boolean }> {
  const content = await gitShowFileAtBase(context.workspaceRoot, context.base, change.file);
  if (content === undefined) return { symbols: [], found: false };
  context.tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-diff-"));
  const tempFile = path.join(context.tempDir, `${index}-${path.posix.basename(change.file)}`);
  await fs.writeFile(tempFile, content, "utf8");
  return { symbols: (await parseFile(tempFile, language)).symbols, found: true };
}

async function diffChangedFile(context: SymbolDiffContext, indexed: IndexedRecordsForFiles, change: ChangedFileInfo, index: number): Promise<FileSymbolDiff & { baselineSymbols: SymbolRecord[]; stale: boolean }> {
  const language = detectLanguage(change.file);
  const stat = change.status === "deleted" ? undefined : await statOrUndefined(change.absolutePath);
  const indexedFile = indexedFileFor(indexed, change);
  const stale = indexedFile !== undefined && (stat === undefined || stat.size !== indexedFile.size || Math.abs(stat.mtimeMs - indexedFile.mtimeMs) > 1);
  const warnings: string[] = [];

  let baseline: SymbolDiffBaseline;
  let before: SymbolRecord[];
  if (context.mode === "index" || (context.mode === "auto" && stale)) {
    baseline = indexedFile ? "index" : "none";
    before = symbolsForChangedFile(indexed, change);
    if (!indexedFile) warnings.push("file is not in the index");
  } else if (change.status === "added" || change.status === "untracked") {
    baseline = "git";
    before = [];
  } else {
    const parsed = await parseAtBase(context, change, language, index);
    baseline = parsed.found ? "git" : "none";
    before = parsed.symbols;
    if (!parsed.found) warnings.push(`file is not readable at ${context.base}`);
  }

  let after: SymbolRecord[] = [];
  if (stat && stat.size > MAX_DIFF_FILE_BYTES) {
    warnings.push(`file is larger than ${MAX_DIFF_FILE_BYTES} bytes; working tree not parsed`);
  } else if (stat && change.absolutePath) {
    after = (await parseFile(change.absolutePath, language)).symbols;
  }
  const diff = diffSymbols(before, after, { includeSignature: context.includeSignature });
  return {
    file: change.file,
    status: change.status,
    baseline,
    ...diff,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    baselineSymbols: before.filter((symbol) => !isCallSiteSymbol(symbol)),
    stale
  };
}

interface ComputedSymbolDiff {
  result: SymbolDiffResult;
  /** Full per-file results (before output bounding), used for deleted files and risk. */
  perFile: Map<string, FileSymbolDiff & { baselineSymbols: SymbolRecord[] }>;
  signatureChanges: number;
}

async function computeSymbolDiff(context: SymbolDiffContext, indexed: IndexedRecordsForFiles, changedFiles: ChangedFileInfo[], maxItems: number, warnings: string[]): Promise<ComputedSymbolDiff> {
  const perFile = new Map<string, FileSymbolDiff & { baselineSymbols: SymbolRecord[] }>();
  const totals = { files: 0, added: 0, removed: 0, changed: 0 };
  let staleIndexFiles = 0;
  let signatureChanges = 0;
  try {
    for (const [index, change] of changedFiles.entries()) {
      if (change.kind === "docs" || !DIFFABLE_LANGUAGES.has(detectLanguage(change.file))) continue;
      try {
        const diff = await diffChangedFile(context, indexed, change, index);
        perFile.set(change.file, diff);
        totals.files += 1;
        totals.added += diff.added.length;
        totals.removed += diff.removed.length;
        totals.changed += diff.changed.length;
        signatureChanges += diff.changed.filter((item) => item.reasons.includes("signature")).length;
        if (diff.stale) staleIndexFiles += 1;
      } catch (error) {
        warnings.push(`Symbol diff failed for ${change.file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  } finally {
    if (context.tempDir) await fs.rm(context.tempDir, { recursive: true, force: true });
  }

  // Bound the output: at most maxItems symbol entries across all files and lists.
  let budget = maxItems;
  let truncated = false;
  const take = <T>(items: T[]): T[] => {
    const taken = items.slice(0, Math.max(0, budget));
    budget -= taken.length;
    if (taken.length < items.length) truncated = true;
    return taken;
  };
  const files: FileSymbolDiff[] = [];
  for (const diff of perFile.values()) {
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && !diff.warning) continue;
    files.push(compact({ file: diff.file, status: diff.status, baseline: diff.baseline, added: take(diff.added), removed: take(diff.removed), changed: take(diff.changed), warning: diff.warning }) as unknown as FileSymbolDiff);
  }
  return { result: { files, totals, staleIndexFiles, truncated }, perFile, signatureChanges };
}

function deletedFilesInfo(changedFiles: ChangedFileInfo[], indexed: IndexedRecordsForFiles, perFile: ComputedSymbolDiff["perFile"] | undefined, includeSource: boolean, maxItems: number): DeletedFileInfo[] {
  return changedFiles.filter((change) => change.status === "deleted").map((change) => {
    const indexedSymbols = symbolsForChangedFile(indexed, change);
    const fromGit = indexedSymbols.length === 0 ? perFile?.get(change.file) : undefined;
    const symbols = indexedSymbols.length > 0 ? indexedSymbols : fromGit?.baseline === "git" ? fromGit.baselineSymbols : [];
    const source: DeletedFileInfo["source"] = indexedSymbols.length > 0 || indexedFileFor(indexed, change) ? "index" : fromGit?.baseline === "git" ? "git" : "none";
    return { file: change.file, kind: change.kind, source, symbolCount: symbols.length, symbols: limitItems(symbols.map((symbol) => compactSymbol(symbol, includeSource)), maxItems) };
  });
}

export async function detectChanges(paths: RuntimePaths, options: DetectChangesOptions = {}): Promise<DetectChangesResult> {
  const base = validateGitBase(options.base);
  const maxFiles = Math.max(1, Math.min(1000, Math.floor(options.maxFiles ?? 200)));
  const maxItems = Math.max(1, Math.min(1000, Math.floor(options.maxItems ?? 100)));
  const maxDepth = Math.max(0, Math.min(8, Math.floor(options.maxDepth ?? 2)));
  const includeSource = options.includeSource === true || options.format === "full";
  const includeRelations = options.includeRelations !== false;
  const includeImpact = options.includeImpact !== false;
  const includeRisk = options.includeRisk !== false;
  const includeSymbolDiff = options.symbolDiff !== false;

  const { files: gitFiles, warnings } = await gitChangedFilesOrWarning(paths.workspaceRoot, base);
  const changedFiles = gitFiles
    .map((change) => ({ ...resolveChangedFile(paths.workspaceRoot, change.file), status: change.status }))
    .filter((file) => includesKind(options.kind, file.kind))
    .slice(0, maxFiles);
  const filePaths = changedFiles.flatMap((file) => [file.file, file.absolutePath ?? file.file]);
  const indexed = await readIndexedRecordsForFiles(sqlitePath(paths.dataDir), filePaths, { includeRelations });

  const changedComponents = indexed.symbols.filter((symbol) => symbol.type === "component");
  const changedSymbols = indexed.symbols.filter((symbol) => !["event", "agent", "mail_event", "component"].includes(symbol.type));
  const changedEvents = indexed.symbols.filter((symbol) => symbol.type === "event");
  const changedAgents = indexed.symbols.filter((symbol) => symbol.type === "agent");
  const changedMailEvents = indexed.symbols.filter((symbol) => symbol.type === "mail_event");
  const symbolDiff = includeSymbolDiff && changedFiles.length > 0
    ? await computeSymbolDiff({ workspaceRoot: paths.workspaceRoot, base, mode: options.diffBaseline ?? "auto", includeSignature: includeSource }, indexed, changedFiles, maxItems, warnings)
    : undefined;
  const deletedFiles = deletedFilesInfo(changedFiles, indexed, symbolDiff?.perFile, includeSource, maxItems);
  const impactResult = includeImpact && changedFiles.length > 0 ? await getImpactRadiusForPaths(paths, { files: changedFiles.map((file) => file.file), base, maxDepth, includeRisk, limit: maxItems, format: options.format }) : undefined;
  const impact = impactResult ? compactImpact(impactResult, maxItems) : undefined;
  const risk = includeRisk ? scoreChangeRisk({
    changedFiles,
    changedEvents,
    changedAgents,
    changedMailEvents,
    relatedRelations: indexed.relations,
    impactRisk: impactResult?.risk,
    deletedFilesWithSymbols: deletedFiles.filter((file) => file.symbolCount > 0).length,
    removedSymbols: symbolDiff?.result.totals.removed,
    signatureChanges: symbolDiff?.signatureChanges
  }) : { score: 0, level: "low", reasons: [] } satisfies ChangeRisk;

  return {
    base,
    changedFiles: changedFiles.map((file) => options.format === "full" ? file : { file: file.file, kind: file.kind, status: file.status }),
    summary: {
      files: changedFiles.length,
      symbols: changedSymbols.length,
      events: changedEvents.length,
      moduleUsages: indexed.moduleUsages.length,
      agents: changedAgents.length,
      mailEvents: changedMailEvents.length,
      components: changedComponents.length,
      ormEntities: indexed.ormEntities.length,
      ormUsages: indexed.ormUsages.length,
      iblockUsages: indexed.iblockUsages.length,
      hlblockUsages: indexed.hlblockUsages.length,
      options: indexed.optionUsages.length,
      relations: includeRelations ? indexed.relations.length : 0,
      deletedFiles: deletedFiles.length,
      untrackedFiles: changedFiles.filter((file) => file.status === "untracked").length,
      symbolsAdded: symbolDiff?.result.totals.added ?? 0,
      symbolsRemoved: symbolDiff?.result.totals.removed ?? 0,
      symbolsChanged: symbolDiff?.result.totals.changed ?? 0
    },
    changedSymbols: limitItems<unknown>(options.format === "full" ? changedSymbols : changedSymbols.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedEvents: limitItems<unknown>(options.format === "full" ? changedEvents : changedEvents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedModuleUsages: limitItems<unknown>(options.format === "full" ? indexed.moduleUsages : indexed.moduleUsages.map((usage) => compactModuleUsage(usage, includeSource)), maxItems),
    changedAgents: limitItems<unknown>(options.format === "full" ? changedAgents : changedAgents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedMailEvents: limitItems<unknown>(options.format === "full" ? changedMailEvents : changedMailEvents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedComponents: limitItems<unknown>(options.format === "full" ? changedComponents : changedComponents.map((symbol) => compactComponent(symbol, includeSource)), maxItems),
    changedOrmEntities: limitItems<unknown>(options.format === "full" ? indexed.ormEntities : indexed.ormEntities.map((entity) => compactOrmEntity(entity, includeSource)), maxItems),
    changedOrmUsages: limitItems<unknown>(options.format === "full" ? indexed.ormUsages : indexed.ormUsages.map((usage) => compactOrmUsage(usage, includeSource)), maxItems),
    changedIblockUsages: limitItems<unknown>(options.format === "full" ? indexed.iblockUsages : indexed.iblockUsages.map((usage) => compactIblockUsage(usage, includeSource)), maxItems),
    changedHlblockUsages: limitItems<unknown>(options.format === "full" ? indexed.hlblockUsages : indexed.hlblockUsages.map((usage) => compactHlblockUsage(usage, includeSource)), maxItems),
    changedOptions: limitItems<unknown>(options.format === "full" ? indexed.optionUsages : indexed.optionUsages.map((usage) => compactOptionUsage(usage, includeSource)), maxItems),
    relatedRelations: includeRelations ? limitItems<unknown>(options.format === "full" ? indexed.relations : indexed.relations.map((relation) => compactRelation(relation, includeSource)), maxItems) : [],
    deletedFiles: limitItems(deletedFiles, maxItems),
    ...(symbolDiff ? { symbolDiff: symbolDiff.result } : {}),
    ...(includeImpact ? { impact: impact ?? emptyImpact() } : {}),
    risk,
    recommendations: recommendationsForChange({ risk, changedComponents, changedOrmEntities: indexed.ormEntities, changedOrmUsages: indexed.ormUsages, changedIblockUsages: indexed.iblockUsages, changedHlblockUsages: indexed.hlblockUsages, changedOptions: indexed.optionUsages, impact, symbolDiff: symbolDiff?.result, deletedFiles }),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export function formatDetectChangesText(result: DetectChangesResult): string {
  const lines = [
    `Changed files vs ${result.base}: ${result.summary.files} (deleted ${result.summary.deletedFiles}; untracked ${result.summary.untrackedFiles})`,
    `Risk: ${result.risk.level} (${result.risk.score}/100)`,
    `Symbols: ${result.summary.symbols}; events: ${result.summary.events}; module usages: ${result.summary.moduleUsages}; agents: ${result.summary.agents}; mail events: ${result.summary.mailEvents}; relations: ${result.summary.relations}`,
    `Components: ${result.summary.components}; ORM entities/usages: ${result.summary.ormEntities}/${result.summary.ormUsages}; iblocks/hlblocks/options: ${result.summary.iblockUsages}/${result.summary.hlblockUsages}/${result.summary.options}`
  ];
  if (result.symbolDiff) {
    lines.push(`Symbol diff: +${result.symbolDiff.totals.added} added; -${result.symbolDiff.totals.removed} removed; ~${result.symbolDiff.totals.changed} changed in ${result.symbolDiff.totals.files} files; truncated ${result.symbolDiff.truncated}`);
  }
  if (result.impact) {
    lines.push(`Impact: events ${result.impact.impacted.events.length}; components ${result.impact.impacted.components.length}; ORM entities ${result.impact.impacted.ormEntities.length}; agents ${result.impact.impacted.agents.length}; mail events ${result.impact.impacted.mailEvents.length}; iblocks/hlblocks/options ${result.impact.impacted.iblocks.length}/${result.impact.impacted.hlblocks.length}/${result.impact.impacted.options.length}; truncated ${result.impact.truncated}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  if (result.changedFiles.length > 0) {
    lines.push("", "Files:", ...result.changedFiles.map((file) => `- ${file.file} [${file.kind}${file.status ? `, ${file.status}` : ""}]`));
  }
  if (result.symbolDiff && result.symbolDiff.files.length > 0) {
    lines.push("", "Symbol changes:");
    for (const file of result.symbolDiff.files) {
      lines.push(`- ${file.file} (before: ${file.baseline})${file.warning ? ` — ${file.warning}` : ""}`);
      for (const symbol of file.added ?? []) lines.push(`  + ${symbol.type} ${symbol.name}`);
      for (const symbol of file.removed ?? []) lines.push(`  - ${symbol.type} ${symbol.name}`);
      for (const symbol of file.changed ?? []) lines.push(`  ~ ${symbol.type} ${symbol.name} (${symbol.reasons.join(", ")})`);
    }
  }
  if (result.deletedFiles.length > 0) {
    lines.push("", "Deleted files:", ...result.deletedFiles.map((file) => `- ${file.file}: ${file.symbolCount} symbols (${file.source})`));
  }
  if (result.risk.reasons.length > 0) {
    lines.push("", "Risk reasons:", ...result.risk.reasons.map((reason) => `- ${reason}`));
  }
  if (result.recommendations.length > 0) {
    lines.push("", "Recommendations:", ...result.recommendations.map((recommendation) => `- ${recommendation}`));
  }
  return `${lines.join("\n")}\n`;
}
