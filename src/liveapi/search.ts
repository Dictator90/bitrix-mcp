import type { IndexManifest, SearchResult, SymbolRecord } from "../types.js";

export interface LiveApiQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

function scoreSymbol(symbol: SymbolRecord, query: string): number {
  const haystack = [symbol.name, symbol.className, symbol.module, symbol.signature, symbol.description].filter(Boolean).join(" ").toLowerCase();
  const needle = query.toLowerCase();
  if (symbol.name.toLowerCase() === needle) return 1;
  if (symbol.name.toLowerCase().includes(needle)) return 0.85;
  if (haystack.includes(needle)) return 0.6;
  return 0;
}

export function searchLiveApi(indices: Array<IndexManifest | undefined>, query: LiveApiQuery): SearchResult<SymbolRecord>[] {
  const limit = query.limit ?? 20;
  return indices
    .flatMap((index) => index?.files.flatMap((file) => file.symbols) ?? [])
    .filter((symbol) => !query.type || symbol.type === query.type)
    .filter((symbol) => !query.module || symbol.module === query.module)
    .map((symbol) => ({ score: scoreSymbol(symbol, query.query), item: symbol }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}
