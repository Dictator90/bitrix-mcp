import fs from "node:fs/promises";
import { parseJsSymbols } from "../liveapi/jsParser.js";
import { parsePhpSymbolsWithDiagnostics } from "../liveapi/phpParser.js";
import type { HlblockUsageRecord, IblockUsageRecord, IndexWarning, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";

/** Everything the indexer extracts from one source file. */
export interface ParsedFile {
  symbols: SymbolRecord[];
  moduleUsages: ModuleUsageRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
  warnings: IndexWarning[];
}

/** Reads and parses one file. Kept free of SQLite imports so it can run in parse worker threads. */
export async function parseFile(absolutePath: string, language: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], warnings: [] };
  if (language === "php") {
    const result = parsePhpSymbolsWithDiagnostics(await fs.readFile(absolutePath, "utf8"), absolutePath);
    return { ...empty, ...result, warnings: result.warnings };
  }
  if (language === "javascript" || language === "typescript") {
    return { ...empty, symbols: parseJsSymbols(await fs.readFile(absolutePath, "utf8"), absolutePath) };
  }
  return empty;
}
