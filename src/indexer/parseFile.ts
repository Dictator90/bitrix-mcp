import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
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

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let fallbackDecoder: TextDecoder | undefined;

function legacyDecoder(): TextDecoder {
  if (!fallbackDecoder) {
    try {
      fallbackDecoder = new TextDecoder("windows-1251");
    } catch {
      // Node built without full ICU: keep the old lossy UTF-8 behaviour.
      fallbackDecoder = new TextDecoder("utf-8");
    }
  }
  return fallbackDecoder;
}

/**
 * Decodes source bytes as UTF-8, falling back to Windows-1251 (legacy non-UTF Bitrix sites)
 * when the bytes are not valid UTF-8. A UTF-8 BOM is stripped.
 */
export function decodeSource(buffer: Uint8Array): string {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return legacyDecoder().decode(buffer);
  }
}

async function readSource(absolutePath: string): Promise<string> {
  return decodeSource(await fs.readFile(absolutePath));
}

/** Reads and parses one file. Kept free of SQLite imports so it can run in parse worker threads. */
export async function parseFile(absolutePath: string, language: string): Promise<ParsedFile> {
  const empty: ParsedFile = { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], warnings: [] };
  if (language === "php") {
    const result = parsePhpSymbolsWithDiagnostics(await readSource(absolutePath), absolutePath);
    return { ...empty, ...result, warnings: result.warnings };
  }
  if (language === "javascript" || language === "typescript") {
    return { ...empty, symbols: parseJsSymbols(await readSource(absolutePath), absolutePath) };
  }
  return empty;
}
