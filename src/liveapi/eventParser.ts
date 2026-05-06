import type { EventRecord } from "../types.js";

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function unquote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/^["']([\s\S]*)["']$/);
  return match?.[1].replace(/\\(["'])/g, "$1");
}

function splitArguments(args: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
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
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      result.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }

  const last = args.slice(start).trim();
  if (last) {
    result.push(last);
  }
  return result;
}

function extractCallArguments(source: string, openParenIndex: number): string | undefined {
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
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }
  return undefined;
}

function callbackHandler(callback: string): Pick<EventRecord, "handlerClass" | "handlerMethod" | "handlerFunction"> {
  const arrayMatch = callback.match(/^(?:array\s*\(|\[)\s*(["'][^"']+["'])\s*,\s*(["'][^"']+["'])/i);
  if (arrayMatch) {
    return { handlerClass: unquote(arrayMatch[1]), handlerMethod: unquote(arrayMatch[2]) };
  }

  const stringValue = unquote(callback);
  if (!stringValue) {
    return {};
  }
  const staticMatch = stringValue.match(/^(.+)::([A-Za-z_][A-Za-z0-9_]*)$/);
  if (staticMatch) {
    return { handlerClass: staticMatch[1], handlerMethod: staticMatch[2] };
  }
  return { handlerFunction: stringValue };
}

function buildEvent(source: string, filePath: string, startIndex: number, signature: string, module: string | undefined, eventName: string | undefined, handler: Pick<EventRecord, "handlerClass" | "handlerMethod" | "handlerFunction">): EventRecord | undefined {
  if (!module || !eventName) {
    return undefined;
  }
  return {
    module,
    eventName,
    handlerClass: handler.handlerClass,
    handlerMethod: handler.handlerMethod,
    handlerFunction: handler.handlerFunction,
    file: filePath,
    line: lineOf(source, startIndex),
    signature
  };
}

export function parsePhpEvents(source: string, filePath: string): EventRecord[] {
  const events: EventRecord[] = [];
  const callRegex = /\b(AddEventHandler|RegisterModuleDependences|addEventHandlerCompatible|addEventHandler|registerEventHandler)\s*\(/gi;

  for (const match of source.matchAll(callRegex)) {
    const callName = match[1];
    const startIndex = match.index ?? 0;
    const openParenIndex = startIndex + match[0].lastIndexOf("(");
    const argsText = extractCallArguments(source, openParenIndex);
    if (!argsText) {
      continue;
    }
    const args = splitArguments(argsText);
    const signature = `${callName}(${argsText.trim()})`;
    const lowerCallName = callName.toLowerCase();

    if (lowerCallName === "addeventhandler" || lowerCallName === "addeventhandlercompatible") {
      const event = buildEvent(source, filePath, startIndex, signature, unquote(args[0]), unquote(args[1]), callbackHandler(args[2] ?? ""));
      if (event) events.push(event);
      continue;
    }

    if (lowerCallName === "registermoduledependences" || lowerCallName === "registereventhandler") {
      const event = buildEvent(source, filePath, startIndex, signature, unquote(args[0]), unquote(args[1]), {
        handlerClass: unquote(args[3]),
        handlerMethod: unquote(args[4])
      });
      if (event) events.push(event);
    }
  }

  return events;
}
