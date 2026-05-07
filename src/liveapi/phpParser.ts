import type { IndexWarning, SymbolRecord } from "../types.js";
import { parsePhpEvents } from "./eventParser.js";
import { parsePhpSymbolsWithAst } from "./phpAstParser.js";

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function moduleFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/bitrix\/modules\/([^/]+)/i) ?? normalized.match(/\/local\/modules\/([^/]+)/i);
  return match?.[1];
}

function parsePhpSymbolsWithRegex(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const module = moduleFromPath(filePath);

  const classRegex = /\b(class|interface|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(classRegex)) {
    symbols.push({
      type: match[1] as "class" | "interface" | "trait",
      name: match[2],
      module,
      file: filePath,
      line: lineOf(source, match.index ?? 0),
      signature: match[0]
    });
  }

  const functionRegex = /(?<!->|::)\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(functionRegex)) {
    const before = source.slice(Math.max(0, (match.index ?? 0) - 500), match.index);
    const classMatch = before.match(/\b(class|interface|trait)\s+([A-Za-z_][A-Za-z0-9_]*)[\s\S]*$/);
    const className = classMatch && before.lastIndexOf("}") < before.lastIndexOf(classMatch[0]) ? classMatch[2] : undefined;
    symbols.push({
      type: className ? "method" : "function",
      name: match[1],
      module,
      className,
      file: filePath,
      line: lineOf(source, match.index ?? 0),
      signature: `function ${match[1]}(${match[2].trim()})`
    });
  }

  for (const event of parsePhpEvents(source, filePath)) {
    symbols.push({
      type: "event",
      name: `${event.module}:${event.eventName}`,
      module: event.module,
      eventName: event.eventName,
      handlerClass: event.handlerClass,
      handlerMethod: event.handlerMethod,
      handlerFunction: event.handlerFunction,
      file: event.file,
      line: event.line,
      signature: event.signature,
      description: event.description
    });
  }

  const componentRegex = /(?:IncludeComponent|includeComponent)\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(componentRegex)) {
    symbols.push({
      type: "component",
      name: match[1],
      module,
      file: filePath,
      line: lineOf(source, match.index ?? 0),
      signature: match[0]
    });
  }

  const constantRegex = /(?:define\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']|\bconst\s+([A-Z_][A-Z0-9_]*))/g;
  for (const match of source.matchAll(constantRegex)) {
    symbols.push({
      type: "constant",
      name: match[1] ?? match[2],
      module,
      file: filePath,
      line: lineOf(source, match.index ?? 0),
      signature: match[0]
    });
  }

  return symbols;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PhpParseResult {
  symbols: SymbolRecord[];
  warnings: IndexWarning[];
}

export function parsePhpSymbolsWithDiagnostics(source: string, filePath: string): PhpParseResult {
  try {
    return { symbols: parsePhpSymbolsWithAst(source, filePath), warnings: [] };
  } catch (error) {
    const warning: IndexWarning = {
      type: "php_parse_fallback",
      file: filePath,
      message: errorMessage(error)
    };
    return { symbols: parsePhpSymbolsWithRegex(source, filePath), warnings: [warning] };
  }
}

export function parsePhpSymbols(source: string, filePath: string): SymbolRecord[] {
  return parsePhpSymbolsWithDiagnostics(source, filePath).symbols;
}
