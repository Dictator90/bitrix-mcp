import type { ComponentParamRecord, HlblockUsageRecord, IblockUsageRecord, IndexWarning, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";
import { lineOf, normalizeAgentName, normalizeHlblockApi, normalizeIblockApi, normalizeOptionApi } from "./bitrixApis.js";
import { parsePhpEvents } from "./eventParser.js";
import { parsePhpWithAst } from "./phpAstParser.js";

function moduleFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/bitrix\/modules\/([^/]+)/i) ?? normalized.match(/\/local\/modules\/([^/]+)/i);
  return match?.[1];
}

const MODULE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function normalizeStaticModuleCall(className: string, methodName: string): ModuleUsageRecord["call"] | undefined {
  const normalizedClass = className.replace(/^\\/, "").toLowerCase();
  const shortClass = normalizedClass.split("\\").pop();
  const normalizedMethod = methodName.toLowerCase();

  if ((normalizedClass === "loader" || normalizedClass === "bitrix\\main\\loader") && normalizedMethod === "includemodule") {
    return "Loader::includeModule";
  }
  if (shortClass === "cmodule" && normalizedMethod === "includemodule") {
    return "CModule::IncludeModule";
  }
  if ((normalizedClass === "modulemanager" || normalizedClass === "bitrix\\main\\modulemanager") && normalizedMethod === "ismoduleinstalled") {
    return "ModuleManager::isModuleInstalled";
  }
  return undefined;
}

function moduleUsageRecord(source: string, filePath: string, index: number, module: string, call: ModuleUsageRecord["call"], signature: string): ModuleUsageRecord | undefined {
  if (!MODULE_NAME_PATTERN.test(module)) return undefined;
  return {
    type: "module_usage",
    module,
    file: filePath,
    line: lineOf(source, index),
    call,
    signature: signature.trim()
  };
}

export function parsePhpModuleUsages(source: string, filePath: string): ModuleUsageRecord[] {
  const usages: ModuleUsageRecord[] = [];
  const staticCallRegex = /(?<![A-Za-z0-9_\\])((?:\\?Bitrix\\Main\\)?(?:Loader|ModuleManager)|\\?CModule)::([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(['"])([^'"]+)\3\s*\)/g;
  for (const match of source.matchAll(staticCallRegex)) {
    const call = normalizeStaticModuleCall(match[1], match[2]);
    if (!call) continue;
    const usage = moduleUsageRecord(source, filePath, match.index ?? 0, match[4], call, match[0]);
    if (usage) usages.push(usage);
  }

  const functionCallRegex = /(?<![A-Za-z0-9_\\:>])IsModuleInstalled\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const match of source.matchAll(functionCallRegex)) {
    const usage = moduleUsageRecord(source, filePath, match.index ?? 0, match[2], "IsModuleInstalled", match[0]);
    if (usage) usages.push(usage);
  }

  return usages.sort((a, b) => a.line - b.line || a.signature.localeCompare(b.signature));
}


function unquotePhpString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed.at(-1) !== quote) return undefined;
  const inner = trimmed.slice(1, -1);
  return quote === "'" ? inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\") : inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function splitTopLevelArgs(argsSource: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const char of argsSource) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || argsSource.trim()) args.push(current.trim());
  return args;
}

function findCallEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}


function parseArrayLiteralValue(argsSource: string, key: string): string | undefined {
  const pattern = new RegExp(`["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*=>\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const match = argsSource.match(pattern);
  return match?.[2].replace(/\\([\\"'])/g, "$1");
}

function siteIdFromArg(arg: string | undefined): string | undefined {
  const literal = unquotePhpString(arg);
  if (literal !== undefined) return literal;
  const trimmed = arg?.trim();
  return trimmed && /^\\?[A-Za-z_][A-Za-z0-9_\\]*$/u.test(trimmed) ? trimmed.replace(/^\\/u, "") : undefined;
}


const COMPONENT_PARAM_KEYS = ["IBLOCK_ID", "CACHE_TYPE", "CACHE_TIME", "SEF_MODE", "AJAX_MODE"] as const;

function normalizeComponentTemplate(value: string | undefined): string {
  return value && value.trim() ? value : ".default";
}

function parsePhpLiteralScalar(value: string | undefined): ComponentParamRecord["value"] {
  if (value === undefined) return "unknown";
  const trimmed = value.trim();
  const stringValue = unquotePhpString(trimmed);
  if (stringValue !== undefined) return stringValue;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/iu.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^null$/iu.test(trimmed)) return null;
  return "unknown";
}

function parseComponentParams(argsSource: string | undefined): ComponentParamRecord[] {
  if (!argsSource) return [];
  const params: ComponentParamRecord[] = [];
  for (const key of COMPONENT_PARAM_KEYS) {
    const pattern = new RegExp(String.raw`["']${key}["']\s*=>\s*(["'][\s\S]*?["']|-?\d+(?:\.\d+)?|true|false|null|[^,\]\)]+)`, "i");
    const match = argsSource.match(pattern);
    if (match) params.push({ name: key, value: parsePhpLiteralScalar(match[1]) });
  }
  return params;
}

function parsePhpMailEventsWithRegex(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const ceventRegex = /(?<![A-Za-z0-9_\\])\\?CEvent::(Send|SendImmediate)\s*\(/g;
  for (const match of source.matchAll(ceventRegex)) {
    const start = match.index ?? 0;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const args = splitTopLevelArgs(source.slice(openParenIndex + 1, end - 1));
    const api = `CEvent::${match[1]}`;
    const eventName = unquotePhpString(args[0]);
    symbols.push({
      type: "mail_event",
      name: eventName ?? api,
      eventName,
      siteId: siteIdFromArg(args[1]),
      api,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }

  const eventSendRegex = /(?<![A-Za-z0-9_\\])\\?Bitrix\\Main\\Mail\\Event::send\s*\(/gi;
  for (const match of source.matchAll(eventSendRegex)) {
    const start = match.index ?? 0;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const argsSource = source.slice(openParenIndex + 1, end - 1);
    const eventName = parseArrayLiteralValue(argsSource, "EVENT_NAME");
    const api = "Bitrix\\Main\\Mail\\Event::send";
    symbols.push({
      type: "mail_event",
      name: eventName ?? api,
      eventName,
      siteId: parseArrayLiteralValue(argsSource, "LID"),
      api,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }
  return symbols;
}

function parsePhpAgentsWithRegex(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const callRegex = /(?<![A-Za-z0-9_\\])\\?CAgent::(AddAgent|RemoveAgent|GetList)\s*\(/g;
  for (const match of source.matchAll(callRegex)) {
    const start = match.index ?? 0;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const args = splitTopLevelArgs(source.slice(openParenIndex + 1, end - 1));
    const action = match[1] as "AddAgent" | "RemoveAgent" | "GetList";
    const agentName = action === "GetList" ? undefined : normalizeAgentName(unquotePhpString(args[0]));
    const intervalRaw = Number(args[3]);
    symbols.push({
      type: "agent",
      name: agentName ?? `CAgent::${action}`,
      module: unquotePhpString(args[1]),
      agentAction: action,
      periodic: unquotePhpString(args[2]),
      interval: Number.isFinite(intervalRaw) ? intervalRaw : undefined,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }
  return symbols;
}

function parsePhpSymbolsWithRegex(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const module = moduleFromPath(filePath);

  const classRegex = /\b(class|interface|trait|enum(?=\s+[A-Za-z_][A-Za-z0-9_]*\s*[:{]|\s+[A-Za-z_][A-Za-z0-9_]*\s+implements\b))\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(classRegex)) {
    symbols.push({
      type: match[1] as "class" | "interface" | "trait" | "enum",
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
      anonymous: event.anonymous,
      file: event.file,
      line: event.line,
      signature: event.signature,
      description: event.description
    });
  }

  const componentRegex = /(?<![A-Za-z0-9_])(?:\$APPLICATION\s*->\s*)?IncludeComponent\s*\(/gi;
  for (const match of source.matchAll(componentRegex)) {
    const start = match.index ?? 0;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const args = splitTopLevelArgs(source.slice(openParenIndex + 1, end - 1));
    const componentName = unquotePhpString(args[0]);
    if (!componentName) continue;
    const params = parseComponentParams(args[2]);
    symbols.push({
      type: "component",
      name: componentName,
      template: normalizeComponentTemplate(unquotePhpString(args[1])),
      params,
      module,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
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

  symbols.push(...parsePhpAgentsWithRegex(source, filePath));
  symbols.push(...parsePhpMailEventsWithRegex(source, filePath));

  return symbols;
}



function parsePhpOptionUsagesWithRegex(source: string, filePath: string): OptionUsageRecord[] {
  const usages: OptionUsageRecord[] = [];
  const callRegex = new RegExp(String.raw`(?<![A-Za-z0-9_])((?:\\\\?Bitrix\\\\Main\\\\Config\\\\Option|Option|\\\\?COption))::([A-Za-z_][A-Za-z0-9_]*)\s*\(`, "g");
  for (const match of source.matchAll(callRegex)) {
    const start = match.index ?? 0;
    if (match[1] === "Option" && source[start - 1] === "\\") continue;
    const className = match[1].replace(/^\\/u, "");
    const config = normalizeOptionApi(className, match[2]);
    if (!config) continue;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const args = splitTopLevelArgs(source.slice(openParenIndex + 1, end - 1));
    const module = unquotePhpString(args[0]);
    const name = unquotePhpString(args[1]);
    if (!module || !name) continue;
    usages.push({
      type: "option",
      module,
      name,
      operation: config.operation,
      api: config.api,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }
  return usages.sort((a, b) => a.line - b.line || a.api.localeCompare(b.api));
}

function parseIblockIdFromArgs(argsSource: string): string {
  const pattern = /["']IBLOCK_ID["']\s*=>\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\$[A-Za-z_][A-Za-z0-9_]*|\\?[A-Za-z_][A-Za-z0-9_\\]*|-?\d+)/i;
  const match = argsSource.match(pattern);
  if (!match) return "unknown";
  const raw = match[1].trim();
  return unquotePhpString(raw) ?? raw.replace(/^\\/u, "");
}

function parsePhpIblockUsagesWithRegex(source: string, filePath: string): IblockUsageRecord[] {
  const usages: IblockUsageRecord[] = [];
  const callRegex = /(?<![A-Za-z0-9_\\])((?:\\?Bitrix\\Iblock\\)?(?:CIBlockElement|CIBlockSection|CIBlockPropertyEnum|ElementTable|SectionTable))::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of source.matchAll(callRegex)) {
    const start = match.index ?? 0;
    const className = match[1].replace(/^\\/u, "");
    const api = normalizeIblockApi(className, match[2]);
    if (!api) continue;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const argsSource = source.slice(openParenIndex + 1, end - 1);
    usages.push({
      type: "iblock_usage",
      iblockId: parseIblockIdFromArgs(argsSource),
      api,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }
  return usages.sort((a, b) => a.line - b.line || a.api.localeCompare(b.api));
}

function parseHlblockIdFromArgs(api: string, argsSource: string): string {
  if (api === "HighloadBlockTable::getById") {
    const first = splitTopLevelArgs(argsSource)[0]?.trim();
    if (!first) return "unknown";
    if (/^-?\d+$/u.test(first)) return first;
    const literal = unquotePhpString(first);
    if (literal !== undefined) return literal;
    if (/^\\?[A-Za-z_][A-Za-z0-9_\\]*$/u.test(first)) return first.replace(/^\\/u, "");
    return "unknown";
  }
  const pattern = /["'](?:HLBLOCK_ID|ID|HLBLOCK_CODE|CODE|NAME)["']\s*=>\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\\?[A-Za-z_][A-Za-z0-9_\\]*|-?\d+)/i;
  const match = argsSource.match(pattern);
  if (!match) return "unknown";
  const raw = match[1].trim();
  return unquotePhpString(raw) ?? raw.replace(/^\\/u, "");
}

function parsePhpHlblockUsagesWithRegex(source: string, filePath: string): HlblockUsageRecord[] {
  const usages: HlblockUsageRecord[] = [];
  const callRegex = /(?<![A-Za-z0-9_\\])((?:\\?Bitrix\\Highloadblock\\)?HighloadBlockTable)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of source.matchAll(callRegex)) {
    const start = match.index ?? 0;
    const className = match[1].replace(/^\\/u, "");
    const api = normalizeHlblockApi(className, match[2]);
    if (!api) continue;
    const openParenIndex = start + match[0].lastIndexOf("(");
    const end = findCallEnd(source, openParenIndex);
    if (end < 0) continue;
    const argsSource = source.slice(openParenIndex + 1, end - 1);
    usages.push({
      type: "hlblock_usage",
      hlblockId: parseHlblockIdFromArgs(api, argsSource),
      api,
      file: filePath,
      line: lineOf(source, start),
      signature: source.slice(start, end).trim()
    });
  }
  return usages.sort((a, b) => a.line - b.line || a.api.localeCompare(b.api));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PhpParseResult {
  symbols: SymbolRecord[];
  moduleUsages: ModuleUsageRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
  warnings: IndexWarning[];
}

function mergeOptionUsages(astUsages: OptionUsageRecord[], regexUsages: OptionUsageRecord[]): OptionUsageRecord[] {
  const key = (usage: OptionUsageRecord): string => `${usage.file}:${usage.line}:${usage.module}:${usage.name}:${usage.api}`;
  const astKeys = new Set(astUsages.map(key));
  return [...astUsages, ...regexUsages.filter((usage) => !astKeys.has(key(usage)))].sort((a, b) => a.line - b.line || a.api.localeCompare(b.api));
}

const REGEX_DECLARATION_TYPES = new Set<SymbolRecord["type"]>(["class", "interface", "trait", "enum", "function"]);
const REGEX_CALL_TYPES = new Set<SymbolRecord["type"]>(["event", "agent", "mail_event", "component"]);

function shortName(name: string): string {
  return (name.split("\\").at(-1) ?? name).toLowerCase();
}

/** Adds regex-found records the partial AST missed (code the error-recovering parser skipped). */
function supplementPartialAst(source: string, filePath: string, symbols: SymbolRecord[]): SymbolRecord[] {
  // The regex cannot reliably tell functions from methods, so an AST method also covers a regex "function".
  const declarationKey = (symbol: SymbolRecord): string => `${symbol.type === "method" ? "function" : symbol.type}:${shortName(symbol.name)}`;
  const declared = new Set(symbols.filter((symbol) => REGEX_DECLARATION_TYPES.has(symbol.type) || symbol.type === "method").map(declarationKey));
  const calls = new Set(symbols.filter((symbol) => REGEX_CALL_TYPES.has(symbol.type)).map((symbol) => `${symbol.type}:${symbol.line}`));
  const extra = parsePhpSymbolsWithRegex(source, filePath).filter((symbol) => {
    if (REGEX_DECLARATION_TYPES.has(symbol.type)) return !declared.has(declarationKey(symbol));
    if (REGEX_CALL_TYPES.has(symbol.type)) return !calls.has(`${symbol.type}:${symbol.line}`);
    return false;
  });
  return extra.length ? [...symbols, ...extra] : symbols;
}

function supplementUsages<T extends { line: number; api: string }>(astUsages: T[], regexUsages: T[]): T[] {
  const keys = new Set(astUsages.map((usage) => `${usage.line}:${usage.api}`));
  return [...astUsages, ...regexUsages.filter((usage) => !keys.has(`${usage.line}:${usage.api}`))];
}

/**
 * Parses PHP with the error-recovering AST parser. Syntax errors keep the partial AST (plus
 * regex-found records it missed) and add a `recovered` warning; the regex-only fallback is used
 * only when php-parser cannot build an AST at all.
 */
export function parsePhpSymbolsWithDiagnostics(source: string, filePath: string): PhpParseResult {
  const moduleUsages = parsePhpModuleUsages(source, filePath);
  const regexOptionUsages = parsePhpOptionUsagesWithRegex(source, filePath);
  let astResult: ReturnType<typeof parsePhpWithAst>;
  try {
    astResult = parsePhpWithAst(source, filePath);
  } catch (error) {
    const warning: IndexWarning = {
      type: "php_parse_fallback",
      file: filePath,
      message: errorMessage(error)
    };
    return { symbols: parsePhpSymbolsWithRegex(source, filePath), moduleUsages, ormEntities: [], ormUsages: [], iblockUsages: parsePhpIblockUsagesWithRegex(source, filePath), hlblockUsages: parsePhpHlblockUsagesWithRegex(source, filePath), optionUsages: regexOptionUsages, warnings: [warning] };
  }

  const { errors, ...result } = astResult;
  const optionUsages = mergeOptionUsages(result.optionUsages, regexOptionUsages);
  if (!errors.length) return { ...result, optionUsages, moduleUsages, warnings: [] };

  const warning: IndexWarning = {
    type: "php_parse_fallback",
    file: filePath,
    message: `Recovered partial AST after ${errors.length} parse error${errors.length === 1 ? "" : "s"}: ${errors[0]}`,
    recovered: true
  };
  return {
    ...result,
    symbols: supplementPartialAst(source, filePath, result.symbols),
    iblockUsages: supplementUsages(result.iblockUsages, parsePhpIblockUsagesWithRegex(source, filePath)),
    hlblockUsages: supplementUsages(result.hlblockUsages, parsePhpHlblockUsagesWithRegex(source, filePath)),
    optionUsages,
    moduleUsages,
    warnings: [warning]
  };
}

export function parsePhpSymbols(source: string, filePath: string): SymbolRecord[] {
  return parsePhpSymbolsWithDiagnostics(source, filePath).symbols;
}
