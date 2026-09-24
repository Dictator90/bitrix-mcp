import fs from "node:fs/promises";
import { parseJsSymbols } from "../liveapi/jsParser.js";
import { extractBitrixFeatures, extractJsBitrixFeatures, type BitrixFeatureRecord } from "../liveapi/bitrixFeatures.js";
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
  bitrixFeatures: BitrixFeatureRecord[];
  warnings: IndexWarning[];
}

/** Reads and parses one file. Kept free of SQLite imports so it can run in parse worker threads. */
/** `relativePath` (workspace-relative) lets path-dependent Bitrix features (lang files, routes, config.php) be recognised. */
export async function parseFile(absolutePath: string, language: string, relativePath: string = absolutePath): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], bitrixFeatures: [], warnings: [] };
  if (language === "php") {
    const source = await fs.readFile(absolutePath, "utf8");
    const result = parsePhpSymbolsWithDiagnostics(source, absolutePath);
    return { ...empty, ...result, bitrixFeatures: extractBitrixFeatures(source, relativePath), warnings: result.warnings };
  }
  if (language === "javascript" || language === "typescript") {
    const source = await fs.readFile(absolutePath, "utf8");
    return { ...empty, symbols: parseJsSymbols(source, absolutePath), bitrixFeatures: extractJsBitrixFeatures(source) };
  }
  return empty;
}
