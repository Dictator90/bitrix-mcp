import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { readIndexedRecordsForFiles } from "./sqliteStore.js";
import type { BitrixRelationRecord, ModuleUsageRecord, SymbolRecord } from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE = "HEAD~1";
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/~@+-]{0,200}$/u;

export type ChangedFileKind = "project" | "template" | "component" | "bitrix" | "install" | "docs" | "asset" | "unknown";
export type RiskLevel = "low" | "medium" | "high";
export type DetectChangesFormat = "compact" | "full";

export interface DetectChangesOptions {
  base?: string;
  kind?: string | string[];
  includeSource?: boolean;
  includeRelations?: boolean;
  maxFiles?: number;
  maxItems?: number;
  format?: DetectChangesFormat;
}

export interface ChangedFileInfo {
  file: string;
  kind: ChangedFileKind;
  absolutePath?: string;
}

export interface ChangeRisk {
  score: number;
  level: RiskLevel;
  reasons: string[];
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
    relations: number;
  };
  changedSymbols: unknown[];
  changedEvents: unknown[];
  changedModuleUsages: unknown[];
  changedAgents: unknown[];
  changedMailEvents: unknown[];
  relatedRelations: unknown[];
  risk: ChangeRisk;
  recommendations: string[];
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function validateGitBase(base: string | undefined): string {
  const normalized = (base ?? DEFAULT_BASE).trim();
  if (!normalized) {
    throw new Error("Git base must not be empty.");
  }
  if (!SAFE_GIT_REF.test(normalized) || normalized.includes("..") || normalized.includes("@{") || normalized.includes("//") || normalized.startsWith("-")) {
    throw new Error(`Unsafe git base ref: ${base ?? ""}`);
  }
  return normalized;
}

export async function gitChangedFiles(workspaceRoot: string, base?: string): Promise<string[]> {
  const safeBase = validateGitBase(base);
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", safeBase, "--"], {
    cwd: workspaceRoot,
    maxBuffer: 2 * 1024 * 1024
  });
  return stdout
    .split(/\r?\n/u)
    .map((line) => normalizeSlashes(line.trim()))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
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
  if (normalized.startsWith("bitrix/modules/")) return "bitrix";
  if (normalized.includes("/install/") || normalized.startsWith("install/")) return "install";
  if (normalized.includes("/components/") || /(^|\/)component(_epilog)?\.php$/u.test(normalized) || ["template.php", "result_modifier.php"].includes(basename)) return "component";
  if (normalized.startsWith("local/templates/") || normalized.startsWith("bitrix/templates/")) return "template";
  if ([".css", ".scss", ".sass", ".less", ".js", ".ts", ".tsx", ".jsx", ".vue", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2"].includes(ext)) return "asset";
  if (normalized.startsWith("local/") || normalized.endsWith(".php")) return "project";
  return "unknown";
}

function compactSymbol(symbol: SymbolRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ type: symbol.type, kind: symbol.kind, name: symbol.name, module: symbol.module, eventName: symbol.eventName, file: symbol.relativeFile ?? symbol.file, line: symbol.line, signature: includeSource ? symbol.signature : undefined });
}

function compactModuleUsage(usage: ModuleUsageRecord, includeSource: boolean): Record<string, unknown> {
  return compact({ module: usage.module, call: usage.call, kind: usage.kind, file: usage.relativeFile ?? usage.file, line: usage.line, signature: includeSource ? usage.signature : undefined });
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
  if (input.relatedRelations.length === 0 && score === 0 && input.changedFiles.length > 0) {
    addReason(reasons, "isolated helper without relations");
  }

  const capped = Math.max(0, Math.min(100, score));
  return { score: capped, level: capped >= 40 ? "high" : capped >= 15 ? "medium" : "low", reasons };
}

function recommendationsForRisk(risk: ChangeRisk): string[] {
  if (risk.level === "high") {
    return ["Review changed Bitrix hooks/install/core files manually before deploy.", "Run focused regression checks for affected modules, events, agents, mail events, and components."];
  }
  if (risk.level === "medium") {
    return ["Review affected templates/assets and smoke-test related UI flows."];
  }
  return ["Run standard tests and verify the changed files are indexed if analysis looks incomplete."];
}

export async function detectChanges(paths: RuntimePaths, options: DetectChangesOptions = {}): Promise<DetectChangesResult> {
  const base = validateGitBase(options.base);
  const maxFiles = Math.max(1, Math.min(1000, Math.floor(options.maxFiles ?? 200)));
  const maxItems = Math.max(1, Math.min(1000, Math.floor(options.maxItems ?? 100)));
  const includeSource = options.includeSource === true || options.format === "full";
  const includeRelations = options.includeRelations !== false;

  const gitFiles = await gitChangedFiles(paths.workspaceRoot, base);
  const changedFiles = gitFiles.map((file) => resolveChangedFile(paths.workspaceRoot, file)).filter((file) => includesKind(options.kind, file.kind)).slice(0, maxFiles);
  const filePaths = changedFiles.flatMap((file) => [file.file, file.absolutePath ?? file.file]);
  const indexed = await readIndexedRecordsForFiles(sqlitePath(paths.dataDir), filePaths, { includeRelations });

  const changedSymbols = indexed.symbols.filter((symbol) => !["event", "agent", "mail_event"].includes(symbol.type));
  const changedEvents = indexed.symbols.filter((symbol) => symbol.type === "event");
  const changedAgents = indexed.symbols.filter((symbol) => symbol.type === "agent");
  const changedMailEvents = indexed.symbols.filter((symbol) => symbol.type === "mail_event");
  const risk = scoreChangeRisk({ changedFiles, changedEvents, changedAgents, changedMailEvents, relatedRelations: indexed.relations });

  return {
    base,
    changedFiles: changedFiles.map((file) => options.format === "full" ? file : { file: file.file, kind: file.kind }),
    summary: {
      files: changedFiles.length,
      symbols: changedSymbols.length,
      events: changedEvents.length,
      moduleUsages: indexed.moduleUsages.length,
      agents: changedAgents.length,
      mailEvents: changedMailEvents.length,
      relations: includeRelations ? indexed.relations.length : 0
    },
    changedSymbols: limitItems<unknown>(options.format === "full" ? changedSymbols : changedSymbols.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedEvents: limitItems<unknown>(options.format === "full" ? changedEvents : changedEvents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedModuleUsages: limitItems<unknown>(options.format === "full" ? indexed.moduleUsages : indexed.moduleUsages.map((usage) => compactModuleUsage(usage, includeSource)), maxItems),
    changedAgents: limitItems<unknown>(options.format === "full" ? changedAgents : changedAgents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    changedMailEvents: limitItems<unknown>(options.format === "full" ? changedMailEvents : changedMailEvents.map((symbol) => compactSymbol(symbol, includeSource)), maxItems),
    relatedRelations: includeRelations ? limitItems<unknown>(options.format === "full" ? indexed.relations : indexed.relations.map((relation) => compactRelation(relation, includeSource)), maxItems) : [],
    risk,
    recommendations: recommendationsForRisk(risk)
  };
}

export function formatDetectChangesText(result: DetectChangesResult): string {
  const lines = [
    `Changed files vs ${result.base}: ${result.summary.files}`,
    `Risk: ${result.risk.level} (${result.risk.score}/100)`,
    `Symbols: ${result.summary.symbols}; events: ${result.summary.events}; module usages: ${result.summary.moduleUsages}; agents: ${result.summary.agents}; mail events: ${result.summary.mailEvents}; relations: ${result.summary.relations}`
  ];
  if (result.changedFiles.length > 0) {
    lines.push("", "Files:", ...result.changedFiles.map((file) => `- ${file.file} [${file.kind}]`));
  }
  if (result.risk.reasons.length > 0) {
    lines.push("", "Risk reasons:", ...result.risk.reasons.map((reason) => `- ${reason}`));
  }
  if (result.recommendations.length > 0) {
    lines.push("", "Recommendations:", ...result.recommendations.map((recommendation) => `- ${recommendation}`));
  }
  return `${lines.join("\n")}\n`;
}
