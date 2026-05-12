import phpParser from "php-parser";
import type { EventRecord, SymbolRecord } from "../types.js";

type PhpNode = {
  kind: string;
  loc?: {
    start: { line: number; offset: number };
    end: { line: number; offset: number };
  };
  [key: string]: unknown;
};

type ParserContext = {
  namespace?: string;
  uses: Map<string, string>;
  className?: string;
};

const parser = new phpParser.Engine({
  parser: {
    extractDoc: true,
    php7: true,
    suppressErrors: false
  },
  ast: {
    withPositions: true
  },
  lexer: {
    short_tags: true
  }
});

function moduleFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/bitrix\/modules\/([^/]+)/i) ?? normalized.match(/\/local\/modules\/([^/]+)/i);
  return match?.[1];
}

function isNode(value: unknown): value is PhpNode {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function nodeName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isNode(value)) return undefined;
  const name = value.name;
  return typeof name === "string" ? name : nodeName(name);
}

function nodeLine(node: PhpNode): number {
  return node.loc?.start.line ?? 1;
}

function sourceSlice(source: string, node: PhpNode): string | undefined {
  if (!node.loc) return undefined;
  return source.slice(node.loc.start.offset, node.loc.end.offset).trim();
}

function declarationSignature(source: string, node: PhpNode): string | undefined {
  if (!node.loc) return undefined;
  const body = isNode(node.body) ? node.body : undefined;
  let end = body?.loc?.start.offset ?? node.loc.end.offset;
  if ((node.kind === "class" || node.kind === "interface" || node.kind === "trait") && node.loc) {
    const bodyStart = source.indexOf("{", node.loc.start.offset);
    if (bodyStart >= 0 && bodyStart < node.loc.end.offset) end = bodyStart;
  }
  return source.slice(node.loc.start.offset, end).trim().replace(/\s+$/u, "");
}

function basename(name: string): string {
  return name.split("\\").filter(Boolean).at(-1) ?? name;
}

function qualifyName(name: string, context: ParserContext, useNamespace = true): string {
  const normalized = name.replace(/^\\/u, "");
  if (name.startsWith("\\")) return normalized;

  const [first, ...rest] = normalized.split("\\");
  const alias = context.uses.get(first.toLowerCase());
  if (alias) {
    return [alias, ...rest].join("\\");
  }

  if (useNamespace && context.namespace && !normalized.includes("\\")) {
    return `${context.namespace}\\${normalized}`;
  }

  return normalized;
}

function fullyQualifiedDeclarationName(name: string, context: ParserContext): string {
  return context.namespace ? `${context.namespace}\\${name}` : name;
}

function cloneContext(context: ParserContext, updates: Partial<ParserContext> = {}): ParserContext {
  return {
    namespace: updates.namespace ?? context.namespace,
    uses: updates.uses ?? new Map(context.uses),
    className: updates.className ?? context.className
  };
}

function addUseAliases(node: PhpNode, context: ParserContext): void {
  const groupPrefix = typeof node.name === "string" ? node.name.replace(/^\\/u, "") : undefined;
  const items = Array.isArray(node.items) ? node.items.filter(isNode) : [];
  for (const item of items) {
    const itemName = typeof item.name === "string" ? item.name.replace(/^\\/u, "") : undefined;
    if (!itemName) continue;
    const fullName = groupPrefix ? `${groupPrefix}\\${itemName}` : itemName;
    const alias = nodeName(item.alias) ?? basename(itemName);
    context.uses.set(alias.toLowerCase(), fullName);
  }
}

function literalString(node: unknown, context: ParserContext): string | undefined {
  if (typeof node === "string") return node;
  if (!isNode(node)) return undefined;

  if (node.kind === "string") {
    return typeof node.value === "string" ? node.value : undefined;
  }

  if (node.kind === "name") {
    const name = nodeName(node);
    return name ? qualifyName(name, context) : undefined;
  }

  if (node.kind === "staticlookup") {
    const offset = nodeName(node.offset);
    const what = nodeName(node.what);
    if (!offset || !what) return undefined;
    const qualifiedWhat = qualifyName(what, context);
    return offset.toLowerCase() === "class" ? qualifiedWhat : `${qualifiedWhat}::${offset}`;
  }

  return undefined;
}


function numericLiteral(node: unknown): number | undefined {
  if (!isNode(node)) return undefined;
  if (node.kind !== "number") return undefined;
  const value = typeof node.value === "number" ? node.value : Number(node.value);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeAgentName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const callable = trimmed.replace(/\s*;\s*$/u, "").replace(/\s*\(\s*\)\s*$/u, "").trim();
  if (/^\\?[A-Za-z_][A-Za-z0-9_\\]*::[A-Za-z_][A-Za-z0-9_]*$/u.test(callable)) return callable;
  if (/^\\?[A-Za-z_][A-Za-z0-9_\\]*$/u.test(callable)) return callable;
  return undefined;
}

function maybeBitrixAgentSymbol(source: string, filePath: string, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || what.kind !== "staticlookup") return undefined;
  const methodName = nodeName(what.offset);
  const className = nodeName(what.what);
  if (!methodName || !className || className.replace(/^\\/u, "").toLowerCase() !== "cagent") return undefined;

  const normalizedMethod = methodName.toLowerCase();
  const agentAction = normalizedMethod === "addagent" ? "AddAgent" : normalizedMethod === "removeagent" ? "RemoveAgent" : normalizedMethod === "getlist" ? "GetList" : undefined;
  if (!agentAction) return undefined;

  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
  const rawAgentName = agentAction === "GetList" ? undefined : literalString(args[0], context);
  const agentName = normalizeAgentName(rawAgentName);
  return {
    type: "agent",
    name: agentName ?? `CAgent::${agentAction}`,
    module: literalString(args[1], context),
    agentAction,
    periodic: literalString(args[2], context),
    interval: numericLiteral(args[3]),
    file: filePath,
    line: nodeLine(node),
    signature: sourceSlice(source, node)
  };
}


function literalArrayValue(node: unknown, key: string, context: ParserContext): string | undefined {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return undefined;
  for (const item of node.items.filter(isNode)) {
    const itemKey = literalString(item.key, context);
    if (itemKey === key) {
      return literalString(item.value, context);
    }
  }
  return undefined;
}

function siteIdValue(node: unknown, context: ParserContext): string | undefined {
  if (!isNode(node)) return literalString(node, context);
  if (node.kind === "name") return nodeName(node)?.replace(/^\\/u, "");
  return literalString(node, context);
}

function normalizedMailClassName(name: string): string {
  return name.replace(/^\\/u, "").replace(/\\+/gu, "\\").toLowerCase();
}

function maybeMailEventSymbol(source: string, filePath: string, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || what.kind !== "staticlookup") return undefined;
  const methodName = nodeName(what.offset);
  const targetName = callTargetName(node, context);
  if (!methodName || !targetName) return undefined;

  const normalizedClass = normalizedMailClassName(targetName);
  const normalizedMethod = methodName.toLowerCase();
  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];

  if (normalizedClass === "cevent" && (normalizedMethod === "send" || normalizedMethod === "sendimmediate")) {
    const api = `CEvent::${methodName}`;
    const eventName = literalString(args[0], context);
    return {
      type: "mail_event",
      name: eventName ?? api,
      eventName,
      siteId: siteIdValue(args[1], context),
      api,
      file: filePath,
      line: nodeLine(node),
      signature: sourceSlice(source, node)
    };
  }

  if (normalizedClass === "bitrix\\main\\mail\\event" && normalizedMethod === "send") {
    const api = "Bitrix\\Main\\Mail\\Event::send";
    const eventName = literalArrayValue(args[0], "EVENT_NAME", context);
    return {
      type: "mail_event",
      name: eventName ?? api,
      eventName,
      siteId: literalArrayValue(args[0], "LID", context),
      api,
      file: filePath,
      line: nodeLine(node),
      signature: sourceSlice(source, node)
    };
  }

  return undefined;
}

function arrayValues(node: unknown): PhpNode[] {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return [];
  return node.items
    .map((item) => (isNode(item) && isNode(item.value) ? item.value : item))
    .filter(isNode);
}

function callbackHandler(node: unknown, context: ParserContext): Pick<EventRecord, "handlerClass" | "handlerMethod" | "handlerFunction" | "anonymous"> {
  if (isNode(node) && node.kind === "closure") {
    return { handlerFunction: "closure", anonymous: true };
  }

  const values = arrayValues(node);
  if (values.length >= 2) {
    const handlerClass = literalString(values[0], context);
    const handlerMethod = literalString(values[1], context);
    if (handlerClass && handlerMethod) return { handlerClass, handlerMethod };
  }

  const value = literalString(node, context);
  if (!value) return {};

  const staticMatch = value.match(/^(.+)::([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (staticMatch) {
    return { handlerClass: staticMatch[1], handlerMethod: staticMatch[2] };
  }

  return { handlerFunction: value };
}

function callName(node: PhpNode): string | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what) return undefined;
  if (what.kind === "identifier" || what.kind === "name") return nodeName(what);
  if (what.kind === "propertylookup" || what.kind === "staticlookup") return nodeName(what.offset);
  return undefined;
}

function callTargetName(node: PhpNode, context: ParserContext): string | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || (what.kind !== "propertylookup" && what.kind !== "staticlookup")) return undefined;
  const target = isNode(what.what) ? what.what : undefined;
  if (!target) return undefined;

  if (target.kind === "name") {
    const name = nodeName(target);
    return name ? qualifyName(name, context) : undefined;
  }

  if (target.kind === "variable") {
    const name = nodeName(target);
    return name ? `$${name}` : undefined;
  }

  if (target.kind === "call") {
    const nestedName = callName(target);
    const nestedTarget = callTargetName(target, context);
    const nestedWhat = isNode(target.what) ? target.what : undefined;
    const operator = nestedWhat?.kind === "propertylookup" ? "->" : "::";
    return nestedTarget && nestedName ? `${nestedTarget}${operator}${nestedName}()` : nestedName;
  }

  return undefined;
}

function buildEvent(source: string, filePath: string, module: string | undefined, eventName: string | undefined, handler: Pick<EventRecord, "handlerClass" | "handlerMethod" | "handlerFunction" | "anonymous">, node: PhpNode): SymbolRecord | undefined {
  if (!module || !eventName) return undefined;
  return {
    type: "event",
    name: `${module}:${eventName}`,
    module,
    eventName,
    handlerClass: handler.handlerClass,
    handlerMethod: handler.handlerMethod,
    handlerFunction: handler.handlerFunction,
    anonymous: handler.anonymous,
    file: filePath,
    line: nodeLine(node),
    signature: sourceSlice(source, node)
  };
}

function maybeEventSymbol(source: string, filePath: string, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const name = callName(node)?.toLowerCase();
  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];

  if (name === "addeventhandler" || name === "addeventhandlercompatible") {
    return buildEvent(source, filePath, literalString(args[0], context), literalString(args[1], context), callbackHandler(args[2], context), node);
  }

  if (name === "registermoduledependences" || name === "registereventhandler") {
    return buildEvent(source, filePath, literalString(args[0], context), literalString(args[1], context), {
      handlerClass: literalString(args[3], context),
      handlerMethod: literalString(args[4], context)
    }, node);
  }

  return undefined;
}

function componentSymbol(source: string, filePath: string, module: string | undefined, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const name = callName(node);
  if (!name || name.toLowerCase() !== "includecomponent") return undefined;
  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
  const componentName = literalString(args[0], context);
  if (!componentName) return undefined;
  return {
    type: "component",
    name: componentName,
    module,
    file: filePath,
    line: nodeLine(node),
    signature: sourceSlice(source, node)
  };
}

function defineConstantSymbol(source: string, filePath: string, module: string | undefined, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  if (callName(node)?.toLowerCase() !== "define") return undefined;
  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
  const constantName = literalString(args[0], context);
  if (!constantName) return undefined;
  return {
    type: "constant",
    name: constantName.includes("\\") ? constantName.replace(/^\\/u, "") : fullyQualifiedDeclarationName(constantName, context),
    module,
    file: filePath,
    line: nodeLine(node),
    signature: sourceSlice(source, node)
  };
}

function callSymbol(source: string, filePath: string, module: string | undefined, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const name = callName(node);
  if (!name) return undefined;
  const what = isNode(node.what) ? node.what : undefined;
  if (!what) return undefined;

  if (what.kind === "staticlookup") {
    const target = callTargetName(node, context);
    return {
      type: "static_call",
      name: target ? `${target}::${name}` : name,
      module,
      className: target,
      file: filePath,
      line: nodeLine(node),
      signature: sourceSlice(source, node)
    };
  }

  if (what.kind === "propertylookup") {
    const target = callTargetName(node, context);
    return {
      type: "method_call",
      name: target ? `${target}->${name}` : name,
      module,
      className: target,
      file: filePath,
      line: nodeLine(node),
      signature: sourceSlice(source, node)
    };
  }

  return undefined;
}

function constantSymbols(source: string, filePath: string, module: string | undefined, node: PhpNode, context: ParserContext): SymbolRecord[] {
  if (!Array.isArray(node.constants)) return [];
  return node.constants.filter(isNode).map((constant) => {
    const name = nodeName(constant) ?? "<anonymous>";
    const qualifiedName = context.className ? `${context.className}::${name}` : fullyQualifiedDeclarationName(name, context);
    return {
      type: "constant" as const,
      name: qualifiedName,
      module,
      className: context.className,
      file: filePath,
      line: nodeLine(constant),
      signature: sourceSlice(source, node)
    };
  });
}

function childrenOf(node: PhpNode): PhpNode[] {
  const children: PhpNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["kind", "loc", "errors", "comments", "leadingComments", "trailingComments", "name", "what", "offset", "arguments", "items", "constants"].includes(key)) {
      continue;
    }
    if (isNode(value)) children.push(value);
    if (Array.isArray(value)) children.push(...value.filter(isNode));
  }
  return children;
}

function visit(source: string, filePath: string, module: string | undefined, node: PhpNode, context: ParserContext, symbols: SymbolRecord[]): void {
  switch (node.kind) {
    case "program":
    case "block":
      for (const child of Array.isArray(node.children) ? node.children.filter(isNode) : []) visit(source, filePath, module, child, context, symbols);
      return;

    case "namespace": {
      const namespaceContext = cloneContext(context, { namespace: typeof node.name === "string" ? node.name : undefined, uses: new Map() });
      for (const child of Array.isArray(node.children) ? node.children.filter(isNode) : []) visit(source, filePath, module, child, namespaceContext, symbols);
      return;
    }

    case "usegroup":
      addUseAliases(node, context);
      return;

    case "class":
    case "interface":
    case "trait": {
      const simpleName = nodeName(node.name);
      if (!simpleName || node.isAnonymous === true) return;
      const className = fullyQualifiedDeclarationName(simpleName, context);
      symbols.push({
        type: node.kind as "class" | "interface" | "trait",
        name: className,
        module,
        file: filePath,
        line: nodeLine(node),
        signature: declarationSignature(source, node)
      });
      const classContext = cloneContext(context, { className });
      for (const child of Array.isArray(node.body) ? node.body.filter(isNode) : []) visit(source, filePath, module, child, classContext, symbols);
      return;
    }

    case "function": {
      const simpleName = nodeName(node.name);
      if (simpleName) {
        symbols.push({
          type: "function",
          name: fullyQualifiedDeclarationName(simpleName, context),
          module,
          file: filePath,
          line: nodeLine(node),
          signature: declarationSignature(source, node)
        });
      }
      for (const child of childrenOf(node)) visit(source, filePath, module, child, context, symbols);
      return;
    }

    case "method": {
      const simpleName = nodeName(node.name);
      if (simpleName) {
        symbols.push({
          type: "method",
          name: simpleName,
          module,
          className: context.className,
          file: filePath,
          line: nodeLine(node),
          signature: declarationSignature(source, node)
        });
      }
      for (const child of childrenOf(node)) visit(source, filePath, module, child, context, symbols);
      return;
    }

    case "constantstatement":
    case "classconstant":
      symbols.push(...constantSymbols(source, filePath, module, node, context));
      return;

    case "call": {
      const agent = maybeBitrixAgentSymbol(source, filePath, node, context);
      if (agent) symbols.push(agent);

      const mailEvent = maybeMailEventSymbol(source, filePath, node, context);
      if (mailEvent) symbols.push(mailEvent);

      const event = maybeEventSymbol(source, filePath, node, context);
      if (event) symbols.push(event);

      const component = componentSymbol(source, filePath, module, node, context);
      if (component) symbols.push(component);

      const definedConstant = defineConstantSymbol(source, filePath, module, node, context);
      if (definedConstant) symbols.push(definedConstant);

      const genericCall = callSymbol(source, filePath, module, node, context);
      if (genericCall) symbols.push(genericCall);

      for (const child of childrenOf(node)) visit(source, filePath, module, child, context, symbols);
      const what = isNode(node.what) ? node.what : undefined;
      if (what && what.kind !== "propertylookup" && what.kind !== "staticlookup") visit(source, filePath, module, what, context, symbols);
      const lookupTarget = what && (what.kind === "propertylookup" || what.kind === "staticlookup") && isNode(what.what) ? what.what : undefined;
      if (lookupTarget) visit(source, filePath, module, lookupTarget, context, symbols);
      for (const argument of Array.isArray(node.arguments) ? node.arguments.filter(isNode) : []) visit(source, filePath, module, argument, context, symbols);
      return;
    }

    default:
      for (const child of childrenOf(node)) visit(source, filePath, module, child, context, symbols);
  }
}

export function parsePhpSymbolsWithAst(source: string, filePath: string): SymbolRecord[] {
  const ast = parser.parseCode(source, filePath) as unknown as PhpNode;
  const symbols: SymbolRecord[] = [];
  visit(source, filePath, moduleFromPath(filePath), ast, { uses: new Map() }, symbols);
  return symbols;
}
