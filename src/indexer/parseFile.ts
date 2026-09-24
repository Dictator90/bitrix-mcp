import fs from "node:fs/promises";
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

// The language parsers are loaded on first use: the TypeScript compiler alone
// costs ~0.4 s to import, and every module that touches the index store reaches
// this file (store -> template -> indexer -> parseFile), including CLI commands
// that never parse anything (`status`, `--version`, ...).
let jsParser: Promise<typeof import("../liveapi/jsParser.js")> | undefined;
let phpParser: Promise<typeof import("../liveapi/phpParser.js")> | undefined;

/** Reads and parses one file. Kept free of SQLite imports so it can run in parse worker threads. */
export async function parseFile(absolutePath: string, language: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], warnings: [] };
  if (language === "php") {
    const { parsePhpSymbolsWithDiagnostics } = await (phpParser ??= import("../liveapi/phpParser.js"));
    const result = parsePhpSymbolsWithDiagnostics(await fs.readFile(absolutePath, "utf8"), absolutePath);
    return { ...empty, ...result, warnings: result.warnings };
  }
  if (language === "javascript" || language === "typescript") {
    const { parseJsSymbols } = await (jsParser ??= import("../liveapi/jsParser.js"));
    return { ...empty, symbols: parseJsSymbols(await fs.readFile(absolutePath, "utf8"), absolutePath) };
  }
  return empty;
}
