import type { BitrixRelationRecord, EventRecord, ModuleUsageRecord, SearchResult, SymbolRecord } from "../types.js";
import type { DocSearchResult } from "../liveapi/search.js";
import type { SemanticSearchHit } from "../search/embeddingsClient.js";

export type SearchFormat = "compact" | "full";

export interface SearchFormatOptions {
  includeSignature?: boolean;
  maxSignatureChars?: number;
  maxTextChars?: number;
  format?: SearchFormat;
  query?: string;
}

export const DEFAULT_MAX_SIGNATURE_CHARS = 160;
export const DEFAULT_MAX_TEXT_CHARS = 500;

interface NormalizedSearchFormatOptions {
  includeSignature: boolean;
  maxSignatureChars: number;
  maxTextChars: number;
  format: SearchFormat;
  query?: string;
}

type JsonRecord = Record<string, unknown>;

function normalizeOptions(options: SearchFormatOptions = {}): NormalizedSearchFormatOptions {
  return {
    includeSignature: options.includeSignature ?? true,
    maxSignatureChars: positiveInteger(options.maxSignatureChars, DEFAULT_MAX_SIGNATURE_CHARS),
    maxTextChars: positiveInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    format: options.format ?? "compact",
    query: options.query
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactObject(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function queryTokens(query: string | undefined): string[] {
  return [...new Set(query?.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((token) => token.length > 1);
}

function highlightMatches(text: string, tokens: string[]): string {
  let highlighted = text;
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlighted = highlighted.replace(new RegExp(`(${escaped})`, "giu"), "**$1**");
  }
  return highlighted;
}

function excerptText(text: string, query: string | undefined, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const tokens = queryTokens(query);
  const lower = normalized.toLowerCase();
  const firstMatch = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstMatch === undefined || normalized.length <= maxChars) {
    return highlightMatches(truncateText(normalized, maxChars) ?? "", tokens);
  }

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, firstMatch - half);
  const end = Math.min(normalized.length, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${highlightMatches(normalized.slice(start, end).trim(), tokens)}${suffix}`;
}

function fullResult<T>(result: SearchResult<T>, options: NormalizedSearchFormatOptions): SearchResult<T> | JsonRecord {
  if (options.includeSignature) return result;
  const item = result.item as JsonRecord;
  return { score: result.score, item: compactObject({ ...item, signature: undefined }) };
}

export function formatLiveApiSearchResults(results: SearchResult<SymbolRecord>[] | undefined, options: SearchFormatOptions = {}): unknown[] | undefined {
  const normalized = normalizeOptions(options);
  if (normalized.format === "full") {
    return results?.map((result) => fullResult(result, normalized));
  }

  return results?.map((result) => compactObject({
    score: result.score,
    type: result.item.type,
    kind: result.item.kind,
    name: result.item.name,
    module: result.item.module,
    file: result.item.file,
    line: result.item.line,
    signature: normalized.includeSignature ? truncateText(result.item.signature, normalized.maxSignatureChars) : undefined
  }));
}

export function formatEventSearchResults(results: SearchResult<EventRecord>[] | undefined, options: SearchFormatOptions = {}): unknown[] | undefined {
  const normalized = normalizeOptions(options);
  if (normalized.format === "full") {
    return results?.map((result) => fullResult(result, normalized));
  }

  return results?.map((result) => compactObject({
    score: result.score,
    type: "event",
    kind: result.item.kind,
    name: result.item.eventName,
    module: result.item.module,
    file: result.item.file,
    line: result.item.line,
    signature: normalized.includeSignature ? truncateText(result.item.signature, normalized.maxSignatureChars) : undefined
  }));
}

export function formatDocSearchResults(results: SearchResult<DocSearchResult>[] | undefined, options: SearchFormatOptions = {}): unknown[] | undefined {
  const normalized = normalizeOptions(options);
  if (normalized.format === "full") {
    return results;
  }

  return results?.map((result) => compactObject({
    score: result.score,
    type: "doc",
    title: result.item.title,
    uri: result.item.uri,
    path: result.item.path,
    headingPath: result.item.headingPath,
    sectionAnchor: result.item.sectionAnchor,
    relativePath: result.item.relativePath,
    chunkIndex: result.item.chunkIndex,
    excerpt: excerptText(result.item.text, normalized.query, normalized.maxTextChars)
  }));
}

export function formatSemanticDocSearchResults(results: SemanticSearchHit[], options: SearchFormatOptions = {}): unknown[] {
  const normalized = normalizeOptions(options);
  if (normalized.format === "full") {
    return results;
  }

  return results.map((result) => compactObject({
    score: result.score,
    type: "doc",
    id: result.id,
    uri: typeof result.metadata.uri === "string" ? result.metadata.uri : undefined,
    title: typeof result.metadata.title === "string" ? result.metadata.title : undefined,
    path: typeof result.metadata.path === "string" ? result.metadata.path : undefined,
    excerpt: excerptText(result.text, normalized.query, normalized.maxTextChars)
  }));
}


export interface ModuleUsageSearchFormatOptions {
  format?: "compact" | "full";
}

export function formatModuleUsageSearchResults(results: ModuleUsageRecord[] | undefined, options: ModuleUsageSearchFormatOptions = {}): unknown[] | undefined {
  if (options.format === "full") {
    return results;
  }

  return results?.map((usage) => compactObject({
    module: usage.module,
    call: usage.call,
    kind: usage.kind,
    file: usage.relativeFile ?? usage.file,
    line: usage.line,
    signature: usage.signature
  }));
}

export interface RelationSearchFormatOptions {
  format?: "compact" | "full";
}

export function formatBitrixRelationSearchResults(results: BitrixRelationRecord[] | undefined, options: RelationSearchFormatOptions = {}): unknown[] | undefined {
  if (options.format === "full") {
    return results;
  }

  return results?.map((relation) => compactObject({
    source: `${relation.sourceType}:${relation.sourceName}`,
    target: `${relation.targetType}:${relation.targetName}`,
    relationType: relation.relationType,
    module: relation.module,
    kind: relation.kind,
    file: relation.file,
    line: relation.line,
    signature: relation.signature
  }));
}
