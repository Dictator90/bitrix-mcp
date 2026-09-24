import phpParser from "php-parser";
import type { ComponentParamRecord, EventRecord, HlblockUsageRecord, IblockUsageRecord, OrmEntityRecord, OrmFieldRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../types.js";
import { normalizeAgentName, normalizeHlblockApi, normalizeIblockApi, normalizeOptionApi } from "./bitrixApis.js";

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
  parentClassName?: string;
  inAnonymousClass?: boolean;
  currentSymbolType?: "method" | "function";
  currentSymbolName?: string;
};

type Collector = {
  source: string;
  filePath: string;
  module?: string;
  symbols: SymbolRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
};

type ParseCode = (source: string, filePath: string) => PhpNode;

/** The php-parser lexer internals patched by {@link createParser}. */
type PhpLexer = {
  _input: string;
  offset: number;
  size: number;
  done: boolean;
  EOF: number;
  next: () => unknown;
  matchST_ATTRIBUTE: () => unknown;
};

/**
 * Builds a php-parser engine whose lexer gets a per-parse token budget: php-parser can spin
 * forever on some malformed input (e.g. an unterminated `#[` attribute at EOF), so a runaway
 * lexer throws instead and the caller falls back to regex parsing.
 */
function createParser(suppressErrors: boolean): ParseCode {
  const engine = new phpParser.Engine({
    parser: {
      extractDoc: true,
      php7: true,
      suppressErrors,
      version: "8.4"
    },
    ast: {
      withPositions: true
    },
    lexer: {
      short_tags: true
    }
  });
  const lexer = (engine as unknown as { lexer: PhpLexer }).lexer;
  const next = lexer.next;
  let remaining = 0;
  lexer.next = function (this: PhpLexer) {
    remaining -= 1;
    if (remaining < 0) throw new Error("PHP lexer did not terminate (malformed input)");
    return next.call(this);
  };
  // php-parser 3.x spins forever in the attribute state when only whitespace is left (`#[Foo` + EOF).
  const matchAttribute = lexer.matchST_ATTRIBUTE;
  lexer.matchST_ATTRIBUTE = function (this: PhpLexer) {
    let index = this.offset;
    while (index < this.size && " \t\r\n".includes(this._input[index])) index += 1;
    if (index >= this.size) {
      this.offset = this.size;
      this.done = true;
      return this.EOF;
    }
    return matchAttribute.call(this);
  };
  return (source, filePath) => {
    remaining = source.length * 4 + 10_000;
    // A trailing newline also stops php-parser's `enum` look-ahead from spinning on a label at EOF.
    const padded = source.endsWith("\n") ? source : `${source}\n`;
    return engine.parseCode(padded, filePath) as unknown as PhpNode;
  };
}

/** Error-recovering parser used for indexing: syntax errors are collected on `program.errors` instead of thrown. */
const parseRecovering = createParser(true);
/** Strict parser for callers that rely on an exception to trigger their own fallback. */
const parseStrict = createParser(false);

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

function nodeEndLine(node: PhpNode): number | undefined {
  return node.loc?.end.line;
}

function nodeArgs(node: PhpNode): PhpNode[] {
  return Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
}

function sourceSlice(source: string, node: PhpNode): string | undefined {
  if (!node.loc) return undefined;
  return source.slice(node.loc.start.offset, node.loc.end.offset).trim();
}

const CLASS_LIKE_KINDS = new Set(["class", "interface", "trait", "enum"]);

function declarationSignature(source: string, node: PhpNode): string | undefined {
  if (!node.loc) return undefined;
  const body = isNode(node.body) ? node.body : undefined;
  let end = body?.loc?.start.offset ?? node.loc.end.offset;
  if (CLASS_LIKE_KINDS.has(node.kind)) {
    const bodyStart = source.indexOf("{", node.loc.start.offset);
    if (bodyStart >= 0 && bodyStart < node.loc.end.offset) end = bodyStart;
  }
  return source.slice(node.loc.start.offset, end).trim().replace(/\s+$/u, "");
}

function basename(name: string): string {
  return name.split("\\").filter(Boolean).at(-1) ?? name;
}

const PHP_BUILTIN_TYPES = new Set([
  "array",
  "bool",
  "boolean",
  "callable",
  "false",
  "float",
  "int",
  "integer",
  "iterable",
  "mixed",
  "never",
  "null",
  "object",
  "self",
  "static",
  "string",
  "true",
  "void"
]);

const RELATIVE_CLASS_NAMES = new Set(["self", "static", "parent"]);

function isBuiltinTypeName(name: string): boolean {
  return PHP_BUILTIN_TYPES.has(name.replace(/^\\/u, "").toLowerCase());
}

function qualifyName(name: string, context: ParserContext, useNamespace = true): string {
  const normalized = name.replace(/^\\/u, "");
  if (name.startsWith("\\")) return normalized;

  const [first, ...rest] = normalized.split("\\");
  const alias = context.uses.get(first.toLowerCase());
  if (alias) {
    return [alias, ...rest].join("\\");
  }

  if (useNamespace && context.namespace && !isBuiltinTypeName(normalized)) {
    return `${context.namespace}\\${normalized}`;
  }

  return normalized;
}

function fullyQualifiedDeclarationName(name: string, context: ParserContext): string {
  return context.namespace ? `${context.namespace}\\${name}` : name;
}

function cloneContext(context: ParserContext, updates: Partial<ParserContext> = {}): ParserContext {
  const pick = <K extends keyof ParserContext>(key: K): ParserContext[K] => (key in updates ? updates[key] : context[key]) as ParserContext[K];
  return {
    namespace: pick("namespace"),
    uses: updates.uses ?? new Map(context.uses),
    className: pick("className"),
    parentClassName: pick("parentClassName"),
    inAnonymousClass: pick("inAnonymousClass"),
    currentSymbolType: pick("currentSymbolType"),
    currentSymbolName: pick("currentSymbolName")
  };
}

function addUseAliases(node: PhpNode, context: ParserContext): void {
  if (node.type === "function" || node.type === "const") return;
  const groupPrefix = typeof node.name === "string" ? node.name.replace(/^\\/u, "") : undefined;
  const items = Array.isArray(node.items) ? node.items.filter(isNode) : [];
  for (const item of items) {
    if (item.type === "function" || item.type === "const") continue;
    const itemName = typeof item.name === "string" ? item.name.replace(/^\\/u, "") : undefined;
    if (!itemName) continue;
    const fullName = groupPrefix ? `${groupPrefix}\\${itemName}` : itemName;
    const alias = nodeName(item.alias) ?? basename(itemName);
    context.uses.set(alias.toLowerCase(), fullName);
  }
}

export function literalString(node: unknown, context: ParserContext): string | undefined {
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

/**
 * Resolves an expression that names a class (`Foo::class`, `'Foo'`, `self::class`,
 * `static::class`, `parent::class`, `__CLASS__`, `$this`, `new Foo`) to a class name,
 * using the enclosing class for the relative forms.
 */
function resolveClassReference(node: unknown, context: ParserContext): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.kind === "string") return typeof node.value === "string" ? node.value : undefined;
  if (node.kind === "magic") return String(node.value).toUpperCase() === "__CLASS__" && !context.inAnonymousClass ? context.className : undefined;
  if (node.kind === "variable") return nodeName(node) === "this" && !context.inAnonymousClass ? context.className : undefined;
  if (node.kind === "new") return classNameOf(node.what, context);
  if (node.kind === "staticlookup") {
    return nodeName(node.offset)?.toLowerCase() === "class" ? classNameOf(node.what, context) : undefined;
  }
  return undefined;
}

/** Class named by a `name`, `self`, `static` or `parent` node; relative forms resolve to the enclosing class. */
function classNameOf(node: unknown, context: ParserContext): string | undefined {
  if (!isNode(node)) return undefined;
  const relative = node.kind === "selfreference" || node.kind === "staticreference" ? "self" : node.kind === "parentreference" ? "parent" : undefined;
  const name = relative ?? (node.kind === "name" ? nodeName(node) : undefined);
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (lower === "self" || lower === "static") return context.inAnonymousClass ? undefined : context.className;
  if (lower === "parent") return context.inAnonymousClass ? undefined : context.parentClassName;
  return qualifyName(name, context);
}

export function literalValue(node: unknown, context: ParserContext): unknown {
  if (!isNode(node)) return undefined;
  if (node.kind === "string") return typeof node.value === "string" ? node.value : undefined;
  if (node.kind === "number") return numericLiteral(node);
  if (node.kind === "boolean") return typeof node.value === "boolean" ? node.value : undefined;
  if (node.kind === "nullkeyword") return null;
  if (node.kind === "name" || node.kind === "staticlookup") return literalString(node, context);
  if (node.kind === "array" && Array.isArray(node.items)) {
    const values: unknown[] = [];
    const object: Record<string, unknown> = {};
    let hasKeys = false;
    for (const item of node.items.filter(isNode)) {
      const key = literalString(item.key, context);
      const value = literalValue(item.value, context);
      if (key !== undefined) {
        hasKeys = true;
        object[key] = value;
      } else {
        values.push(value);
      }
    }
    return hasKeys ? object : values;
  }
  return undefined;
}

export function numericLiteral(node: unknown): number | undefined {
  if (!isNode(node)) return undefined;
  if (node.kind !== "number") return undefined;
  const value = typeof node.value === "number" ? node.value : Number(node.value);
  return Number.isFinite(value) ? value : undefined;
}

const DOC_SUMMARY_LIMIT = 300;

function docComment(node: PhpNode): string | undefined {
  const sources = [node.leadingComments, ...(Array.isArray(node.attrGroups) ? node.attrGroups.filter(isNode).map((group) => group.leadingComments) : [])];
  for (const comments of sources) {
    if (!Array.isArray(comments)) continue;
    const doc = comments.filter(isNode).filter((comment) => comment.kind === "commentblock" && typeof comment.value === "string" && comment.value.startsWith("/**")).at(-1);
    if (doc) return doc.value as string;
  }
  return undefined;
}

/** First paragraph of a PHPDoc block, without `*` gutters or tags, capped to {@link DOC_SUMMARY_LIMIT} chars. */
export function phpDocSummary(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const lines = doc
    .replace(/^\/\*\*/u, "")
    .replace(/\*\/$/u, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\*\s?/u, "").trim());
  const summary: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@")) break;
    if (!line) {
      if (summary.length) break;
      continue;
    }
    summary.push(line);
  }
  const text = summary.join(" ").replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > DOC_SUMMARY_LIMIT ? `${text.slice(0, DOC_SUMMARY_LIMIT - 1).trimEnd()}…` : text;
}

function attributeNames(node: PhpNode, context: ParserContext): string[] | undefined {
  const names: string[] = [];
  for (const group of Array.isArray(node.attrGroups) ? node.attrGroups.filter(isNode) : []) {
    for (const attribute of Array.isArray(group.attrs) ? group.attrs.filter(isNode) : []) {
      const name = nodeName(attribute);
      if (name) names.push(qualifyName(name, context));
    }
  }
  return names.length ? names : undefined;
}

// ---------------------------------------------------------------------------
// ORM entities

const ORM_BASE_CLASSES = new Set(["bitrix\\main\\entity\\datamanager", "bitrix\\main\\orm\\data\\datamanager"]);

const ORM_FIELD_CLASSES = new Set([
  "integerfield",
  "floatfield",
  "decimalfield",
  "stringfield",
  "textfield",
  "booleanfield",
  "datetimefield",
  "datefield",
  "enumfield",
  "arrayfield",
  "objectfield",
  "cryptofield",
  "expressionfield",
  "referencefield",
  "reference",
  "onetomany",
  "manytomany"
]);
const ORM_REFERENCE_CLASSES = new Set(["referencefield", "reference", "onetomany", "manytomany"]);

/** Bitrix `ScalarField` fluent configurators and the legacy array option they correspond to. */
const ORM_FLUENT_OPTIONS = new Map<string, string>([
  ["configureprimary", "primary"],
  ["configureautocomplete", "autocomplete"],
  ["configurerequired", "required"],
  ["configuredefaultvalue", "default_value"],
  ["configuretitle", "title"],
  ["configurevalues", "values"]
]);

/** Legacy array-style `getMap()` `data_type` values mapped to their D7 field classes. */
const ORM_LEGACY_DATA_TYPES = new Map<string, string>([
  ["integer", "IntegerField"],
  ["float", "FloatField"],
  ["string", "StringField"],
  ["text", "TextField"],
  ["boolean", "BooleanField"],
  ["date", "DateField"],
  ["datetime", "DatetimeField"],
  ["enum", "EnumField"]
]);

const ORM_OPTION_KEYS = ["primary", "autocomplete", "required", "default_value", "values", "title"];

function literalOptions(node: unknown, context: ParserContext): Record<string, unknown> | undefined {
  const value = literalValue(node, context);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const picked: Record<string, unknown> = {};
    for (const key of ORM_OPTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) picked[key] = (value as Record<string, unknown>)[key];
    }
    return Object.keys(picked).length ? picked : undefined;
  }
  return undefined;
}

function methodReturnExpression(method: PhpNode | undefined): PhpNode | undefined {
  if (!method) return undefined;
  const body = isNode(method.body) ? method.body : undefined;
  const children = Array.isArray(body?.children) ? body.children.filter(isNode) : [];
  const returnNode = children.find((child) => child.kind === "return");
  return isNode(returnNode?.expr) ? returnNode.expr : undefined;
}

function findClassMethod(node: PhpNode, name: string): PhpNode | undefined {
  const methods = Array.isArray(node.body) ? node.body.filter(isNode) : [];
  return methods.find((child) => child.kind === "method" && nodeName(child.name)?.toLowerCase() === name.toLowerCase());
}

function newFieldRecord(source: string, node: PhpNode, context: ParserContext): OrmFieldRecord | undefined {
  if (node.kind !== "new") return undefined;
  const className = nodeName(node.what);
  if (!className) return undefined;
  const shortName = basename(className).toLowerCase();
  if (!ORM_FIELD_CLASSES.has(shortName)) return undefined;
  const args = nodeArgs(node);
  const fieldName = literalString(args[0], context) ?? basename(className);
  const field: OrmFieldRecord = {
    name: fieldName,
    type: basename(className),
    className: qualifyName(className, context, false),
    line: nodeLine(node),
    signature: sourceSlice(source, node)
  };
  const options = literalOptions(args[1], context) ?? literalOptions(args[2], context);
  if (options) field.options = options;
  if (ORM_REFERENCE_CLASSES.has(shortName)) {
    const referenceClass = resolveClassReference(args[1], context) ?? literalString(args[1], context);
    if (referenceClass) field.referenceClass = referenceClass;
  }
  return field;
}

/** Parses `new XField(...)` optionally wrapped in a fluent `->configure*()` chain. */
function fluentFieldRecord(source: string, node: PhpNode, context: ParserContext): OrmFieldRecord | undefined {
  const chain: PhpNode[] = [];
  let current: PhpNode = node;
  while (current.kind === "call" && isNode(current.what) && current.what.kind === "propertylookup" && isNode(current.what.what)) {
    chain.unshift(current);
    current = current.what.what;
  }
  const field = newFieldRecord(source, current, context);
  if (!field) return undefined;
  for (const call of chain) {
    const option = ORM_FLUENT_OPTIONS.get((nodeName((call.what as PhpNode).offset) ?? "").toLowerCase());
    if (!option) continue;
    const args = nodeArgs(call);
    const value = args.length ? literalValue(args[0], context) : true;
    field.options = { ...(field.options ?? {}), [option]: value === undefined ? "unknown" : value };
  }
  if (chain.length) {
    field.line = nodeLine(node);
    field.signature = sourceSlice(source, node);
  }
  return field;
}

/** Parses a legacy `'NAME' => ['data_type' => 'integer', 'primary' => true]` map entry. */
function legacyFieldRecord(source: string, name: string, item: PhpNode, value: PhpNode, context: ParserContext): OrmFieldRecord | undefined {
  if (value.kind !== "array" || !Array.isArray(value.items)) return undefined;
  let dataType: string | undefined;
  let hasReference = false;
  let hasExpression = false;
  for (const entry of value.items.filter(isNode)) {
    const key = literalString(entry.key, context)?.toLowerCase();
    if (key === "data_type") dataType = resolveClassReference(entry.value, context) ?? literalString(entry.value, context);
    if (key === "reference") hasReference = true;
    if (key === "expression") hasExpression = true;
  }
  if (!dataType && !hasExpression) return undefined;
  const scalarType = dataType ? ORM_LEGACY_DATA_TYPES.get(dataType.toLowerCase()) : undefined;
  const type = hasExpression ? "ExpressionField" : hasReference ? "ReferenceField" : scalarType ?? dataType ?? "ScalarField";
  const field: OrmFieldRecord = { name, type, line: nodeLine(item), signature: sourceSlice(source, item) };
  const options = literalOptions(value, context);
  if (options) field.options = options;
  if (hasReference && dataType) field.referenceClass = dataType;
  return field;
}

/** Collects `$var = [...]`, `$var[] = ...` and `$var['KEY'] = ...` statements from a method body. */
function mapVariableItems(method: PhpNode): Map<string, PhpNode[]> {
  const variables = new Map<string, PhpNode[]>();
  const body = isNode(method.body) ? method.body : undefined;
  for (const statement of Array.isArray(body?.children) ? body.children.filter(isNode) : []) {
    const expression = statement.kind === "expressionstatement" && isNode(statement.expression) ? statement.expression : undefined;
    if (!expression || expression.kind !== "assign" || !isNode(expression.left) || !isNode(expression.right)) continue;
    const left = expression.left;
    if (left.kind === "variable" && expression.operator === "=") {
      const name = nodeName(left);
      if (name) variables.set(name, [expression.right]);
    } else if (left.kind === "offsetlookup" && isNode(left.what) && left.what.kind === "variable") {
      const name = nodeName(left.what);
      if (!name) continue;
      const key = isNode(left.offset) ? left.offset : undefined;
      const entry: PhpNode = { kind: "entry", key, value: expression.right, loc: expression.loc };
      variables.set(name, [...(variables.get(name) ?? []), entry]);
    }
  }
  return variables;
}

function collectOrmFields(source: string, method: PhpNode | undefined, context: ParserContext): OrmFieldRecord[] {
  if (!method) return [];
  const variables = mapVariableItems(method);
  const fields: OrmFieldRecord[] = [];
  const seenVariables = new Set<string>();

  const fromEntry = (item: PhpNode): void => {
    const value = item.kind === "entry" ? (isNode(item.value) ? item.value : undefined) : item;
    if (!value) return;
    const key = item.kind === "entry" ? literalString(item.key, context) : undefined;
    if (key && value.kind === "array") {
      const legacy = legacyFieldRecord(source, key, item, value, context);
      if (legacy) fields.push(legacy);
      return;
    }
    fromExpression(value);
  };

  const fromExpression = (expression: PhpNode): void => {
    if (expression.kind === "array") {
      for (const item of Array.isArray(expression.items) ? expression.items.filter(isNode) : []) fromEntry(item);
      return;
    }
    if (expression.kind === "variable") {
      const name = nodeName(expression);
      if (!name || seenVariables.has(name)) return;
      seenVariables.add(name);
      for (const item of variables.get(name) ?? []) fromEntry(item);
      return;
    }
    const field = fluentFieldRecord(source, expression, context);
    if (field) {
      fields.push(field);
      return;
    }
    if (expression.kind === "call") {
      for (const argument of nodeArgs(expression)) fromExpression(argument);
    }
  };

  const returned = methodReturnExpression(method);
  if (returned) fromExpression(returned);
  return fields;
}

function isOrmEntityDeclaration(node: PhpNode, simpleName: string, parentClass: string | undefined): boolean {
  if (!parentClass) return false;
  if (ORM_BASE_CLASSES.has(parentClass.toLowerCase())) return true;
  const tableMethod = findClassMethod(node, "getTableName");
  if (tableMethod?.isStatic === true && methodReturnExpression(tableMethod)?.kind === "string") return true;
  const definesOrmMethod = Boolean(tableMethod ?? findClassMethod(node, "getMap"));
  const parentShort = basename(parentClass).toLowerCase();
  return definesOrmMethod && (simpleName.toLowerCase().endsWith("table") || parentShort.endsWith("table") || parentShort === "datamanager");
}

function maybeOrmEntity(collector: Collector, node: PhpNode, context: ParserContext): OrmEntityRecord | undefined {
  if (node.kind !== "class") return undefined;
  const simpleName = nodeName(node.name);
  const parentName = nodeName(node.extends);
  if (!simpleName || !parentName) return undefined;
  const parentClass = qualifyName(parentName, context, false);
  if (!isOrmEntityDeclaration(node, simpleName, parentClass)) return undefined;
  const className = fullyQualifiedDeclarationName(simpleName, context);
  const tableMethod = findClassMethod(node, "getTableName");
  const fields = collectOrmFields(collector.source, findClassMethod(node, "getMap"), context);
  const references = fields.filter((field) => ORM_REFERENCE_CLASSES.has(field.type.toLowerCase()) || field.referenceClass);
  return {
    type: "orm_entity",
    className,
    fullyQualifiedName: className,
    namespace: context.namespace,
    parentClass,
    module: collector.module,
    tableName: literalString(methodReturnExpression(tableMethod), context),
    file: collector.filePath,
    line: nodeLine(node),
    fields,
    references,
    signature: declarationSignature(collector.source, node)
  };
}

// ---------------------------------------------------------------------------
// Call helpers

function callName(node: PhpNode): string | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what) return undefined;
  if (what.kind === "identifier" || what.kind === "name") return nodeName(what)?.replace(/^\\/u, "");
  if (what.kind === "propertylookup" || what.kind === "nullsafepropertylookup" || what.kind === "staticlookup") return nodeName(what.offset);
  return undefined;
}

function callTargetName(node: PhpNode, context: ParserContext): string | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || (what.kind !== "propertylookup" && what.kind !== "nullsafepropertylookup" && what.kind !== "staticlookup")) return undefined;
  const target = isNode(what.what) ? what.what : undefined;
  if (!target) return undefined;

  if (target.kind === "name" || target.kind === "selfreference" || target.kind === "staticreference" || target.kind === "parentreference") {
    return classNameOf(target, context);
  }

  if (target.kind === "variable") {
    const name = nodeName(target);
    return name ? `$${name}` : undefined;
  }

  if (target.kind === "call") {
    const nestedName = callName(target);
    const nestedTarget = callTargetName(target, context);
    const nestedWhat = isNode(target.what) ? target.what : undefined;
    const operator = nestedWhat?.kind === "staticlookup" ? "::" : "->";
    return nestedTarget && nestedName ? `${nestedTarget}${operator}${nestedName}()` : nestedName;
  }

  return undefined;
}

function staticCallParts(node: PhpNode, context: ParserContext): { methodName: string; targetName: string } | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || what.kind !== "staticlookup") return undefined;
  const methodName = nodeName(what.offset);
  const targetName = callTargetName(node, context);
  return methodName && targetName ? { methodName, targetName } : undefined;
}

// ---------------------------------------------------------------------------
// IBlock / Highloadblock / Option usages

function scalarValue(node: unknown, context: ParserContext, allowVariables: boolean): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.kind === "number") {
    const value = numericLiteral(node);
    return value === undefined ? undefined : String(value);
  }
  if (node.kind === "string") return typeof node.value === "string" ? node.value : undefined;
  if (node.kind === "name" || node.kind === "staticlookup") return literalString(node, context);
  if (allowVariables && node.kind === "variable") {
    const name = nodeName(node);
    return name ? `$${name}` : undefined;
  }
  return undefined;
}

function iblockIdFromArray(node: unknown, context: ParserContext): string | undefined {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return undefined;
  for (const item of node.items.filter(isNode)) {
    const key = literalString(item.key, context);
    if (key?.toUpperCase() === "IBLOCK_ID") {
      return scalarValue(item.value, context, true) ?? "unknown";
    }
    const nested = iblockIdFromArray(item.value, context);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findIblockIdInArgs(args: PhpNode[], context: ParserContext): string {
  for (const arg of args) {
    const value = iblockIdFromArray(arg, context);
    if (value !== undefined) return value;
  }
  return "unknown";
}

function hlblockIdFromArray(node: unknown, context: ParserContext): string | undefined {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return undefined;
  for (const item of node.items.filter(isNode)) {
    const key = literalString(item.key, context)?.replace(/^=/u, "").toUpperCase();
    if (key === "HLBLOCK_ID" || key === "ID" || key === "HLBLOCK_CODE" || key === "CODE" || key === "NAME") {
      return scalarValue(item.value, context, false) ?? "unknown";
    }
    const nested = hlblockIdFromArray(item.value, context);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findHlblockIdInArgs(api: string, args: PhpNode[], context: ParserContext): string {
  if (api === "HighloadBlockTable::getById") {
    return scalarValue(args[0], context, false) ?? "unknown";
  }
  for (const arg of args) {
    const value = hlblockIdFromArray(arg, context);
    if (value !== undefined) return value;
  }
  return "unknown";
}

function maybeHlblockUsage(collector: Collector, node: PhpNode, context: ParserContext): HlblockUsageRecord | undefined {
  const parts = staticCallParts(node, context);
  const api = parts ? normalizeHlblockApi(parts.targetName, parts.methodName) : undefined;
  if (!api) return undefined;
  return {
    type: "hlblock_usage",
    hlblockId: findHlblockIdInArgs(api, nodeArgs(node), context),
    api,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node) ?? `${api}(...)`,
    contextType: context.currentSymbolType,
    contextName: context.currentSymbolName
  };
}

function maybeIblockUsage(collector: Collector, node: PhpNode, context: ParserContext): IblockUsageRecord | undefined {
  const parts = staticCallParts(node, context);
  const api = parts ? normalizeIblockApi(parts.targetName, parts.methodName) : undefined;
  if (!api) return undefined;
  return {
    type: "iblock_usage",
    iblockId: findIblockIdInArgs(nodeArgs(node), context),
    api,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node) ?? `${api}(...)`,
    contextType: context.currentSymbolType,
    contextName: context.currentSymbolName
  };
}

function maybeOptionUsage(collector: Collector, node: PhpNode, context: ParserContext): OptionUsageRecord | undefined {
  const parts = staticCallParts(node, context);
  const config = parts ? normalizeOptionApi(parts.targetName, parts.methodName) : undefined;
  if (!parts || !config) return undefined;
  const targetNode = isNode(node.what) && isNode((node.what as PhpNode).what) ? ((node.what as PhpNode).what as PhpNode) : undefined;
  const rawTargetName = targetNode?.kind === "name" ? nodeName(targetNode)?.replace(/^\\/u, "") : undefined;
  const api = rawTargetName?.toLowerCase() === "option" ? `Option::${parts.methodName}` : config.api;
  const args = nodeArgs(node);
  const module = literalString(args[0], context);
  const name = literalString(args[1], context);
  if (!module || !name) return undefined;
  return {
    type: "option",
    module,
    name,
    operation: config.operation,
    api,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node) ?? `${api}(...)`,
    contextType: context.currentSymbolType,
    contextName: context.currentSymbolName
  };
}

// ---------------------------------------------------------------------------
// ORM usages

const ORM_USAGE_METHODS = new Set(["query", "getlist", "getbyid", "getbyprimary", "getrow", "getcount", "add", "addmulti", "update", "updatemulti", "delete"]);

function maybeOrmUsage(collector: Collector, node: PhpNode, context: ParserContext): OrmUsageRecord | undefined {
  const parts = staticCallParts(node, context);
  if (!parts) return undefined;
  const { methodName, targetName } = parts;
  const normalizedMethod = methodName.toLowerCase();
  const normalizedTarget = targetName.replace(/^\\/u, "").toLowerCase();
  const base = { type: "orm_usage" as const, entity: targetName, method: methodName, module: collector.module, file: collector.filePath, line: nodeLine(node), signature: sourceSlice(collector.source, node) };
  if (ORM_USAGE_METHODS.has(normalizedMethod)) {
    const targetNode = (node.what as PhpNode).what;
    if (!isNode(targetNode) || targetNode.kind !== "name" || RELATIVE_CLASS_NAMES.has(normalizedTarget)) return undefined;
    return { ...base, usageKind: "datamanager" };
  }
  if (normalizedTarget === "bitrix\\main\\entity" && normalizedMethod === "compileentity") {
    return { ...base, usageKind: "compile_entity" };
  }
  if (normalizedTarget.endsWith("section") && normalizedMethod === "compileentitybyiblock") {
    return { ...base, usageKind: "compile_entity_by_iblock" };
  }
  return undefined;
}

/** Keeps DataManager-style usages only for `*Table` classes or entities declared in the same file. */
function filterOrmUsages(usages: OrmUsageRecord[], entities: OrmEntityRecord[]): OrmUsageRecord[] {
  const entityNames = new Set(entities.map((entity) => entity.className.toLowerCase()));
  return usages.filter((usage) => {
    if (usage.usageKind !== "datamanager") return true;
    const entity = usage.entity.replace(/^\\/u, "").toLowerCase();
    return entity.endsWith("table") || entityNames.has(entity);
  });
}

// ---------------------------------------------------------------------------
// Agents, mail events, components, constants

function maybeBitrixAgentSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const what = isNode(node.what) ? node.what : undefined;
  if (!what || what.kind !== "staticlookup") return undefined;
  const methodName = nodeName(what.offset);
  const className = nodeName(what.what);
  if (!methodName || !className || className.replace(/^\\/u, "").toLowerCase() !== "cagent") return undefined;

  const normalizedMethod = methodName.toLowerCase();
  const agentAction = normalizedMethod === "addagent" ? "AddAgent" : normalizedMethod === "removeagent" ? "RemoveAgent" : normalizedMethod === "getlist" ? "GetList" : undefined;
  if (!agentAction) return undefined;

  const args = nodeArgs(node);
  const rawAgentName = agentAction === "GetList" ? undefined : literalString(args[0], context);
  const agentName = normalizeAgentName(rawAgentName);
  return {
    type: "agent",
    name: agentName ?? `CAgent::${agentAction}`,
    module: literalString(args[1], context),
    agentAction,
    periodic: literalString(args[2], context),
    interval: numericLiteral(args[3]),
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node)
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

function maybeMailEventSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const parts = staticCallParts(node, context);
  if (!parts) return undefined;
  const normalizedClass = parts.targetName.replace(/^\\/u, "").replace(/\\+/gu, "\\").toLowerCase();
  const normalizedMethod = parts.methodName.toLowerCase();
  const args = nodeArgs(node);

  if (normalizedClass === "cevent" && (normalizedMethod === "send" || normalizedMethod === "sendimmediate")) {
    const api = `CEvent::${parts.methodName}`;
    const eventName = literalString(args[0], context);
    return {
      type: "mail_event",
      name: eventName ?? api,
      eventName,
      siteId: siteIdValue(args[1], context),
      api,
      file: collector.filePath,
      line: nodeLine(node),
      signature: sourceSlice(collector.source, node)
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
      file: collector.filePath,
      line: nodeLine(node),
      signature: sourceSlice(collector.source, node)
    };
  }

  return undefined;
}

const COMPONENT_PARAM_KEYS = new Set(["IBLOCK_ID", "CACHE_TYPE", "CACHE_TIME", "SEF_MODE", "AJAX_MODE"]);

function componentParams(node: unknown, context: ParserContext): ComponentParamRecord[] {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return [];
  const params: ComponentParamRecord[] = [];
  for (const item of node.items.filter(isNode)) {
    const key = literalString(item.key, context);
    if (!key || !COMPONENT_PARAM_KEYS.has(key)) continue;
    const value = literalValue(item.value, context);
    params.push({
      name: key,
      value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : "unknown"
    });
  }
  return params;
}

function componentSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const name = callName(node);
  if (!name || name.toLowerCase() !== "includecomponent") return undefined;
  const args = nodeArgs(node);
  const componentName = literalString(args[0], context);
  if (!componentName) return undefined;
  const template = literalString(args[1], context);
  return {
    type: "component",
    name: componentName,
    template: template && template.trim() ? template : ".default",
    params: componentParams(args[2], context),
    module: collector.module,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node)
  };
}

function defineConstantSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  if (callName(node)?.toLowerCase() !== "define") return undefined;
  const constantName = literalString(nodeArgs(node)[0], context);
  if (!constantName) return undefined;
  return {
    type: "constant",
    name: constantName.includes("\\") ? constantName.replace(/^\\/u, "") : fullyQualifiedDeclarationName(constantName, context),
    module: collector.module,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node)
  };
}

function callSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const name = callName(node);
  const what = isNode(node.what) ? node.what : undefined;
  if (!name || !what) return undefined;
  const isStatic = what.kind === "staticlookup";
  if (!isStatic && what.kind !== "propertylookup" && what.kind !== "nullsafepropertylookup") return undefined;
  const target = callTargetName(node, context);
  return {
    type: isStatic ? "static_call" : "method_call",
    name: target ? `${target}${isStatic ? "::" : "->"}${name}` : name,
    module: collector.module,
    className: target,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node)
  };
}

// ---------------------------------------------------------------------------
// Events

type EventHandler = Pick<EventRecord, "handlerClass" | "handlerMethod" | "handlerFunction" | "anonymous">;

function arrayValues(node: unknown): PhpNode[] {
  if (!isNode(node) || node.kind !== "array" || !Array.isArray(node.items)) return [];
  return node.items
    .map((item) => (isNode(item) && isNode(item.value) ? item.value : item))
    .filter(isNode);
}

function callbackHandler(node: unknown, context: ParserContext): EventHandler {
  if (isNode(node) && (node.kind === "closure" || node.kind === "arrowfunc")) {
    return { handlerFunction: "closure", anonymous: true };
  }

  const values = arrayValues(node);
  if (values.length >= 2) {
    const handlerClass = resolveClassReference(values[0], context);
    const handlerMethod = literalString(values[1], context);
    if (handlerClass && handlerMethod) return { handlerClass, handlerMethod };
    return {};
  }

  const value = literalString(node, context);
  if (!value) return {};

  const staticMatch = value.match(/^(.+)::([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (staticMatch) {
    return { handlerClass: staticMatch[1], handlerMethod: staticMatch[2] };
  }

  return { handlerFunction: value };
}

function eventSymbolBase(collector: Collector, node: PhpNode, module: string | undefined, eventName: string): Omit<SymbolRecord, "type"> {
  return {
    name: module ? `${module}:${eventName}` : eventName,
    module,
    eventName,
    file: collector.filePath,
    line: nodeLine(node),
    signature: sourceSlice(collector.source, node)
  };
}

const EVENT_HANDLER_CALLS = new Set(["addeventhandler", "addeventhandlercompatible"]);
const EVENT_REGISTER_CALLS = new Set(["registermoduledependences", "registereventhandler", "registereventhandlercompatible"]);
const EVENT_UNREGISTER_CALLS = new Set(["unregistermoduledependences", "unregistereventhandler"]);

function maybeEventSymbol(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const rawName = callName(node);
  const name = rawName?.toLowerCase();
  if (!rawName || !name) return undefined;
  const args = nodeArgs(node);
  const module = literalString(args[0], context);
  const eventName = literalString(args[1], context);

  if (EVENT_HANDLER_CALLS.has(name) || EVENT_REGISTER_CALLS.has(name)) {
    if (!module || !eventName) return undefined;
    const handler = EVENT_HANDLER_CALLS.has(name) ? callbackHandler(args[2], context) : { handlerClass: resolveClassReference(args[3], context) ?? literalString(args[3], context), handlerMethod: literalString(args[4], context) };
    return {
      type: "event",
      ...eventSymbolBase(collector, node, module, eventName),
      handlerClass: handler.handlerClass,
      handlerMethod: handler.handlerMethod,
      handlerFunction: handler.handlerFunction,
      anonymous: handler.anonymous
    };
  }

  if (EVENT_UNREGISTER_CALLS.has(name)) {
    if (!module || !eventName) return undefined;
    return {
      type: "event_unregister",
      ...eventSymbolBase(collector, node, module, eventName),
      api: rawName,
      handlerClass: resolveClassReference(args[3], context) ?? literalString(args[3], context),
      handlerMethod: literalString(args[4], context)
    };
  }

  // GetModuleEvents() (legacy) and EventManager::findEventHandlers() (D7) look up handlers in order to fire an event.
  if (name === "getmoduleevents" || name === "findeventhandlers") {
    if (!eventName) return undefined;
    return eventEmitSymbol(collector, node, context, module, eventName, name === "getmoduleevents" ? "GetModuleEvents" : "EventManager::findEventHandlers");
  }

  return undefined;
}

function eventEmitSymbol(collector: Collector, node: PhpNode, context: ParserContext, module: string | undefined, eventName: string, api: string): SymbolRecord {
  return {
    type: "event_emit",
    ...eventSymbolBase(collector, node, module, eventName),
    api,
    namespace: context.namespace,
    className: context.inAnonymousClass ? undefined : context.className,
    description: context.currentSymbolName ? `Fired in ${context.currentSymbolName}` : undefined
  };
}

/** `new \Bitrix\Main\Event('module', 'OnSomething', [...])`. */
function maybeEventEmitFromNew(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord | undefined {
  const what = isNode(node.what) && node.what.kind === "name" ? nodeName(node.what) : undefined;
  if (!what || qualifyName(what, context).toLowerCase() !== "bitrix\\main\\event") return undefined;
  const args = nodeArgs(node);
  const eventName = literalString(args[1], context);
  if (!eventName) return undefined;
  return eventEmitSymbol(collector, node, context, literalString(args[0], context), eventName, "Bitrix\\Main\\Event");
}

// ---------------------------------------------------------------------------
// Declarations

function typeName(source: string, value: unknown, context: ParserContext): string | undefined {
  if (typeof value === "string") return value;
  if (!isNode(value)) return undefined;
  if (typeof value.raw === "string") return value.raw;
  if (value.kind === "name" || value.kind === "typereference") {
    const name = nodeName(value);
    return name ? qualifyName(name, context) : undefined;
  }
  if ((value.kind === "uniontype" || value.kind === "intersectiontype") && Array.isArray(value.types)) {
    const separator = value.kind === "uniontype" ? "|" : "&";
    const types = value.types.map((item) => typeName(source, item, context)).filter((item): item is string => Boolean(item));
    return types.length > 0 ? types.join(separator) : undefined;
  }
  return sourceSlice(source, value);
}

function returnTypeName(source: string, node: PhpNode, context: ParserContext): string | undefined {
  const type = typeName(source, node.type, context);
  if (!type) return undefined;
  return node.nullable === true && !type.startsWith("?") ? `?${type}` : type;
}

function parameterRecords(source: string, node: PhpNode, context: ParserContext): SymbolRecord["parameters"] {
  return nodeArgs(node).map((argument) => {
    const record: NonNullable<SymbolRecord["parameters"]>[number] = {
      name: nodeName(argument.name) ?? "<anonymous>",
      nullable: argument.nullable === true,
      variadic: argument.variadic === true
    };
    const type = typeName(source, argument.type, context);
    if (type) record.type = type;
    const defaultValue = isNode(argument.value) ? sourceSlice(source, argument.value) : undefined;
    if (defaultValue !== undefined) record.default = defaultValue;
    return record;
  });
}

function methodVisibility(node: PhpNode): SymbolRecord["visibility"] {
  return node.visibility === "protected" || node.visibility === "private" ? node.visibility : "public";
}

function qualifiedNames(value: unknown, context: ParserContext): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map((item) => nodeName(item))
    .filter((name): name is string => Boolean(name))
    .map((name) => qualifyName(name, context));
}

function traitNames(node: PhpNode, context: ParserContext): string[] {
  const body = Array.isArray(node.body) ? node.body.filter(isNode) : [];
  return body.filter((child) => child.kind === "traituse").flatMap((child) => qualifiedNames(child.traits, context));
}

function constantSymbols(collector: Collector, node: PhpNode, context: ParserContext): SymbolRecord[] {
  if (!Array.isArray(node.constants)) return [];
  return node.constants.filter(isNode).map((constant) => {
    const name = nodeName(constant) ?? "<anonymous>";
    return {
      type: "constant" as const,
      name: context.className ? `${context.className}::${name}` : fullyQualifiedDeclarationName(name, context),
      module: collector.module,
      className: context.className,
      file: collector.filePath,
      line: nodeLine(constant),
      signature: sourceSlice(collector.source, node)
    };
  });
}

function classLikeSymbol(collector: Collector, node: PhpNode, context: ParserContext, simpleName: string): SymbolRecord {
  const className = fullyQualifiedDeclarationName(simpleName, context);
  // Interfaces may extend several interfaces: the first one is kept in `extends`, the rest in `implements`.
  const parents = qualifiedNames(node.extends, context);
  const implementsNames = [...(node.kind === "interface" ? parents.slice(1) : []), ...qualifiedNames(node.implements, context)];
  const usedTraits = traitNames(node, context);
  return {
    type: node.kind as "class" | "interface" | "trait" | "enum",
    name: className,
    fullyQualifiedName: className,
    namespace: context.namespace,
    className: simpleName,
    module: collector.module,
    file: collector.filePath,
    line: nodeLine(node),
    lineEnd: nodeEndLine(node),
    abstract: node.isAbstract === true,
    final: node.isFinal === true,
    extends: parents[0],
    implements: implementsNames.length ? implementsNames : undefined,
    traits: usedTraits.length ? usedTraits : undefined,
    attributes: attributeNames(node, context),
    signature: declarationSignature(collector.source, node),
    description: phpDocSummary(docComment(node))
  };
}

// ---------------------------------------------------------------------------
// Traversal

const SKIPPED_CHILD_KEYS = new Set(["kind", "loc", "errors", "comments", "leadingComments", "trailingComments", "attrGroups"]);

/** Every child node of `node`, so that expressions nested anywhere (arrays, `new` arguments, lookups) are visited once. */
function childrenOf(node: PhpNode): PhpNode[] {
  const children: PhpNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_CHILD_KEYS.has(key)) continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) children.push(...value.filter(isNode));
  }
  return children;
}

function visitChildren(collector: Collector, node: PhpNode, context: ParserContext): void {
  for (const child of childrenOf(node)) visit(collector, child, context);
}

function visitCall(collector: Collector, node: PhpNode, context: ParserContext): void {
  const symbolDetectors = [maybeBitrixAgentSymbol, maybeMailEventSymbol, maybeEventSymbol, componentSymbol, defineConstantSymbol, callSymbol];
  for (const detect of symbolDetectors) {
    const symbol = detect(collector, node, context);
    if (symbol) collector.symbols.push(symbol);
  }
  const ormUsage = maybeOrmUsage(collector, node, context);
  if (ormUsage) collector.ormUsages.push(ormUsage);
  const iblockUsage = maybeIblockUsage(collector, node, context);
  if (iblockUsage) collector.iblockUsages.push(iblockUsage);
  const hlblockUsage = maybeHlblockUsage(collector, node, context);
  if (hlblockUsage) collector.hlblockUsages.push(hlblockUsage);
  const optionUsage = maybeOptionUsage(collector, node, context);
  if (optionUsage) collector.optionUsages.push(optionUsage);
}

function visit(collector: Collector, node: PhpNode, context: ParserContext): void {
  switch (node.kind) {
    case "namespace": {
      const namespaceContext = cloneContext(context, { namespace: typeof node.name === "string" && node.name ? node.name : undefined, uses: new Map() });
      for (const child of Array.isArray(node.children) ? node.children.filter(isNode) : []) visit(collector, child, namespaceContext);
      return;
    }

    case "usegroup":
      addUseAliases(node, context);
      return;

    case "class":
    case "interface":
    case "trait":
    case "enum": {
      const simpleName = nodeName(node.name);
      const body = Array.isArray(node.body) ? node.body.filter(isNode) : [];
      if (!simpleName || node.isAnonymous === true) {
        const parentName = nodeName(node.extends);
        const anonymousContext = cloneContext(context, { inAnonymousClass: true, parentClassName: parentName ? qualifyName(parentName, context) : undefined });
        for (const child of body) visit(collector, child, anonymousContext);
        return;
      }
      const symbol = classLikeSymbol(collector, node, context, simpleName);
      collector.symbols.push(symbol);
      const entity = maybeOrmEntity(collector, node, context);
      if (entity) collector.ormEntities.push(entity);
      const classContext = cloneContext(context, {
        className: symbol.name,
        parentClassName: node.kind === "class" ? symbol.extends : undefined,
        inAnonymousClass: false
      });
      for (const child of body) visit(collector, child, classContext);
      return;
    }

    case "function": {
      const simpleName = nodeName(node.name);
      const functionName = simpleName ? fullyQualifiedDeclarationName(simpleName, context) : undefined;
      if (functionName) {
        collector.symbols.push({
          type: "function",
          name: functionName,
          fullyQualifiedName: functionName,
          namespace: context.namespace,
          module: collector.module,
          file: collector.filePath,
          line: nodeLine(node),
          lineEnd: nodeEndLine(node),
          returnType: returnTypeName(collector.source, node, context),
          parameters: parameterRecords(collector.source, node, context),
          attributes: attributeNames(node, context),
          signature: declarationSignature(collector.source, node),
          description: phpDocSummary(docComment(node))
        });
      }
      visitChildren(collector, node, cloneContext(context, { currentSymbolType: "function", currentSymbolName: functionName ?? context.currentSymbolName }));
      return;
    }

    case "method": {
      const simpleName = nodeName(node.name);
      const methodName = simpleName ? (context.className ? `${context.className}::${simpleName}` : simpleName) : undefined;
      if (simpleName && methodName && !context.inAnonymousClass) {
        collector.symbols.push({
          type: "method",
          name: simpleName,
          fullyQualifiedName: methodName,
          namespace: context.namespace,
          module: collector.module,
          className: context.className,
          file: collector.filePath,
          line: nodeLine(node),
          lineEnd: nodeEndLine(node),
          visibility: methodVisibility(node),
          static: node.isStatic === true,
          abstract: node.isAbstract === true,
          final: node.isFinal === true,
          returnType: returnTypeName(collector.source, node, context),
          parameters: parameterRecords(collector.source, node, context),
          attributes: attributeNames(node, context),
          signature: declarationSignature(collector.source, node),
          description: phpDocSummary(docComment(node))
        });
      }
      const symbolName = context.inAnonymousClass ? context.currentSymbolName : methodName ?? context.currentSymbolName;
      visitChildren(collector, node, cloneContext(context, { currentSymbolType: "method", currentSymbolName: symbolName }));
      return;
    }

    case "constantstatement":
    case "classconstant":
      if (!context.inAnonymousClass) collector.symbols.push(...constantSymbols(collector, node, context));
      return;

    case "enumcase": {
      const caseName = nodeName(node.name);
      if (caseName && context.className && !context.inAnonymousClass) {
        collector.symbols.push({
          type: "constant",
          name: `${context.className}::${caseName}`,
          module: collector.module,
          className: context.className,
          file: collector.filePath,
          line: nodeLine(node),
          signature: sourceSlice(collector.source, node)
        });
      }
      return;
    }

    case "call":
      visitCall(collector, node, context);
      visitChildren(collector, node, context);
      return;

    case "new": {
      const emit = maybeEventEmitFromNew(collector, node, context);
      if (emit) collector.symbols.push(emit);
      visitChildren(collector, node, context);
      return;
    }

    default:
      visitChildren(collector, node, context);
  }
}

export interface PhpAstParseResult {
  symbols: SymbolRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
  /** Syntax errors the parser recovered from; the other fields hold what the partial AST yielded. */
  errors: string[];
}

function parseErrors(ast: PhpNode): string[] {
  return (Array.isArray(ast.errors) ? ast.errors.filter(isNode) : []).map((error) => (typeof error.message === "string" ? error.message : "Parse error"));
}

/** Parses PHP with error recovery; throws only when php-parser cannot produce any AST. */
export function parsePhpWithAst(source: string, filePath: string): PhpAstParseResult {
  const ast = parseRecovering(source, filePath);
  const collector: Collector = {
    source,
    filePath,
    module: moduleFromPath(filePath),
    symbols: [],
    ormEntities: [],
    ormUsages: [],
    iblockUsages: [],
    hlblockUsages: [],
    optionUsages: []
  };
  visit(collector, ast, { uses: new Map() });
  return {
    symbols: collector.symbols,
    ormEntities: collector.ormEntities,
    ormUsages: filterOrmUsages(collector.ormUsages, collector.ormEntities),
    iblockUsages: collector.iblockUsages,
    hlblockUsages: collector.hlblockUsages,
    optionUsages: collector.optionUsages,
    errors: parseErrors(ast)
  };
}

export function parsePhpSymbolsWithAst(source: string, filePath: string): SymbolRecord[] {
  return parsePhpWithAst(source, filePath).symbols;
}

/** Strict parse: throws on the first syntax error. */
export function parsePhpToAst(source: string, filePath: string): PhpNode {
  return parseStrict(source, filePath);
}
