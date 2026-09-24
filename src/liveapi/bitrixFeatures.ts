import path from "node:path";
import { parsePhpToAst } from "./phpAstParser.js";

/**
 * Bitrix framework constructs that are not classic symbols: D7 controller
 * actions, routes, urlrewrite rules, REST methods, language phrases and their
 * usages, JS extensions, autoload registrations, user fields, iblock
 * properties, and component parameters/descriptions.
 */
export type BitrixFeatureType =
  | "controller_action"
  | "route"
  | "urlrewrite_rule"
  | "rest_method"
  | "lang_phrase"
  | "lang_usage"
  | "js_extension"
  | "js_extension_usage"
  | "autoload_class"
  | "autoload_namespace"
  | "user_field"
  | "iblock_property"
  | "component_parameter"
  | "component_description"
  | "ajax_call"
  | "js_event";

export interface BitrixFeatureRecord {
  featureType: BitrixFeatureType;
  /** Main lookup key: action/route/REST method/phrase/extension/field/property/parameter name. */
  name: string;
  line: number;
  /** What the feature points at: handler `Class::method`, component id, file, etc. */
  target?: string;
  module?: string;
  detail?: Record<string, unknown>;
}

type Node = { kind: string; loc?: { start?: { line?: number } }; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function lineOf(node: Node): number {
  return node.loc?.start?.line ?? 1;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isNode(value) && typeof value.name === "string") return value.name;
  return undefined;
}

interface Scope {
  namespace: string;
  uses: Map<string, string>;
  /** FQN of the enclosing class, for `__CLASS__`, `self::class` and `static::class`. */
  className?: string;
}

function resolveName(node: unknown, scope: Scope): string | undefined {
  if (!isNode(node) || node.kind !== "name" || typeof node.name !== "string") return undefined;
  const raw = node.name;
  if (node.resolution === "fqn" || raw.startsWith("\\")) return raw.replace(/^\\/u, "");
  const [first, ...rest] = raw.split("\\");
  const alias = scope.uses.get(first.toLowerCase());
  if (alias) return [alias, ...rest].join("\\");
  if (["self", "static"].includes(raw.toLowerCase())) return scope.className ?? raw;
  if (raw.toLowerCase() === "parent") return raw;
  return scope.namespace ? `${scope.namespace}\\${raw}` : raw;
}

/** Evaluates literal PHP expressions: strings, numbers, booleans, arrays, `X::class`, and string concatenation. */
function literal(node: unknown, scope: Scope): unknown {
  if (!isNode(node)) return undefined;
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return Number(node.value);
    case "boolean":
      return node.value;
    case "nullkeyword":
      return null;
    case "magic":
      return node.value === "__CLASS__" ? scope.className : undefined;
    case "staticlookup": {
      const offset = identifier(node.offset);
      const owner = resolveName(node.what, scope);
      return owner && offset?.toLowerCase() === "class" ? owner : owner && offset ? `${owner}::${offset}` : undefined;
    }
    case "bin": {
      if (node.type !== ".") return undefined;
      const left = literal(node.left, scope);
      const right = literal(node.right, scope);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    case "array": {
      const items = Array.isArray(node.items) ? node.items.filter(isNode) : [];
      const list: unknown[] = [];
      const map: Record<string, unknown> = {};
      let keyed = false;
      for (const item of items) {
        const entry = item.kind === "entry" ? item : { key: undefined, value: item };
        const key = literal(entry.key, scope);
        const value = literal(entry.value, scope);
        if (typeof key === "string" || typeof key === "number") {
          keyed = true;
          map[String(key)] = value;
        } else {
          list.push(value);
        }
      }
      return keyed ? map : list;
    }
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function callableTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") return `${value[0]}::${value[1]}`;
  const record = asRecord(value);
  if (record?.callback !== undefined) return callableTarget(record.callback);
  return undefined;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Walks every child node (generic, so nothing nested is skipped). */
function children(node: Node): Node[] {
  const result: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) result.push(item);
    } else if (isNode(value)) {
      result.push(value);
    }
  }
  return result;
}

const CONTROLLER_BASES = new Set(["bitrix\\main\\engine\\controller", "bitrix\\main\\engine\\jsoncontroller"]);
const CONTROLLERABLE = "bitrix\\main\\engine\\contract\\controllerable";
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "any", "head", "options"]);
const REST_METHOD_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u;

function moduleFromPath(relativePath: string): string | undefined {
  return relativePath.match(/(?:^|\/)(?:bitrix|local)\/modules\/([^/]+)\//u)?.[1];
}

/** `bitrix/js/ui/buttons/config.php` → `ui.buttons`; `local/js/vendor/widget/config.php` → `vendor.widget`. */
export function jsExtensionNameFromPath(relativePath: string): string | undefined {
  const match = relativePath.replace(/\\/gu, "/").match(/(?:^|\/)(?:bitrix|local)\/js\/(.+)\/config\.php$/u)
    ?? relativePath.replace(/\\/gu, "/").match(/(?:^|\/)(?:bitrix|local)\/modules\/[^/]+\/install\/js\/(.+)\/config\.php$/u);
  return match ? match[1].split("/").join(".") : undefined;
}

/**
 * Extracts Bitrix framework features from one PHP file. `relativePath` is the
 * workspace-relative path (slash-normalized); some features depend on it
 * (lang files, urlrewrite.php, routes/, component .parameters.php, JS config.php).
 */
export function extractBitrixFeatures(source: string, relativePath: string): BitrixFeatureRecord[] {
  const normalizedPath = relativePath.replace(/\\/gu, "/");
  const fileName = path.posix.basename(normalizedPath);
  const module = moduleFromPath(normalizedPath);
  const records: BitrixFeatureRecord[] = [];
  const add = (record: BitrixFeatureRecord) => records.push(module && !record.module ? { ...record, module } : record);

  let ast: Node;
  try {
    ast = parsePhpToAst(source, relativePath) as unknown as Node;
  } catch {
    return records;
  }

  const langMatch = normalizedPath.match(/(?:^|\/)lang\/([a-z]{2})\//u);
  const isRestFile = /OnRestServiceBuildDescription/iu.test(source);
  const isRoutesFile = /(?:^|\/)routes\/[^/]+\.php$/u.test(normalizedPath);
  const jsExtension = fileName === "config.php" ? jsExtensionNameFromPath(normalizedPath) : undefined;

  const visit = (node: Node, scope: Scope, routePrefix: string) => {
    switch (node.kind) {
      case "namespace": {
        const inner: Scope = { namespace: typeof node.name === "string" ? node.name : "", uses: new Map(scope.uses) };
        for (const child of children(node)) visit(child, inner, routePrefix);
        return;
      }
      case "usegroup": {
        const prefix = typeof node.name === "string" ? node.name.replace(/^\\/u, "") : "";
        for (const item of (Array.isArray(node.items) ? node.items : []).filter(isNode)) {
          const name = typeof item.name === "string" ? item.name.replace(/^\\/u, "") : undefined;
          if (!name) continue;
          const full = prefix ? `${prefix}\\${name}` : name;
          scope.uses.set((identifier(item.alias) ?? full.split("\\").pop() ?? full).toLowerCase(), full);
        }
        return;
      }
      case "class": {
        visitClass(node, scope);
        const className = identifier(node.name);
        const inner: Scope = { ...scope, className: className ? (scope.namespace ? `${scope.namespace}\\${className}` : className) : scope.className };
        for (const child of children(node)) visit(child, inner, routePrefix);
        return;
      }
      case "assign":
        visitAssign(node, scope);
        break;
      case "call":
        visitCall(node, scope, routePrefix);
        break;
      case "return":
        if (isRestFile && isNode(node.expr)) visitRestArray(literal(node.expr, scope), lineOf(node));
        if (jsExtension && isNode(node.expr)) {
          const config = asRecord(literal(node.expr, scope));
          if (config) add({ featureType: "js_extension", name: jsExtension, line: lineOf(node), detail: { js: config.js, css: config.css, rel: config.rel } });
        }
        break;
      default:
        break;
    }
    if (node.kind === "call" && isRoutesFile) return; // route calls handle their own nested groups
    for (const child of children(node)) visit(child, scope, routePrefix);
  };

  const visitClass = (node: Node, scope: Scope) => {
    const className = identifier(node.name);
    if (!className) return;
    const fqn = scope.namespace ? `${scope.namespace}\\${className}` : className;
    const parent = resolveName(node.extends, scope)?.toLowerCase();
    const implemented = (Array.isArray(node.implements) ? node.implements : []).map((item) => resolveName(item, scope)?.toLowerCase());
    const isController = (parent !== undefined && CONTROLLER_BASES.has(parent)) || implemented.includes(CONTROLLERABLE);
    if (!isController) return;
    const methods = (Array.isArray(node.body) ? node.body : []).filter(isNode).filter((member) => member.kind === "method");
    const seen = new Set<string>();
    for (const method of methods) {
      const methodName = identifier(method.name);
      if (!methodName || !/Action$/u.test(methodName) || methodName === "Action") continue;
      if (method.visibility && method.visibility !== "public") continue;
      const action = methodName.slice(0, -"Action".length);
      seen.add(action.toLowerCase());
      add({ featureType: "controller_action", name: `${fqn}::${action}`, line: lineOf(method), target: `${fqn}::${methodName}`, detail: { controller: fqn, action } });
    }
    const configure = methods.find((method) => identifier(method.name)?.toLowerCase() === "configureactions");
    const body = configure && isNode(configure.body) ? configure.body : undefined;
    const returned = body && Array.isArray(body.children) ? body.children.filter(isNode).find((child) => child.kind === "return") : undefined;
    const configured = returned ? asRecord(literal(returned.expr, scope)) : undefined;
    for (const action of Object.keys(configured ?? {})) {
      if (seen.has(action.toLowerCase())) continue;
      add({ featureType: "controller_action", name: `${fqn}::${action}`, line: lineOf(returned as Node), target: `${fqn}::${action}Action`, detail: { controller: fqn, action, configuredOnly: true } });
    }
  };

  const visitAssign = (node: Node, scope: Scope) => {
    const left = isNode(node.left) ? node.left : undefined;
    // $MESS['KEY'] = 'text';
    if (langMatch && left?.kind === "offsetlookup" && isNode(left.what) && left.what.kind === "variable" && left.what.name === "MESS") {
      const key = literal(left.offset, scope);
      const text = literal(node.right, scope);
      if (typeof key === "string") add({ featureType: "lang_phrase", name: key, line: lineOf(node), detail: { lang: langMatch[1], text: typeof text === "string" ? truncate(text) : undefined } });
      return;
    }
    const variable = left?.kind === "variable" && typeof left.name === "string" ? left.name : undefined;
    const value = literal(node.right, scope);
    if (variable === "arUrlRewrite" && fileName === "urlrewrite.php" && Array.isArray(value)) {
      for (const rule of value.map(asRecord)) {
        if (!rule || typeof rule.CONDITION !== "string") continue;
        add({ featureType: "urlrewrite_rule", name: rule.CONDITION, line: lineOf(node), target: typeof rule.ID === "string" && rule.ID ? rule.ID : undefined, detail: { path: rule.PATH, rule: rule.RULE, sort: rule.SORT } });
      }
      return;
    }
    if (variable === "arComponentParameters" && fileName === ".parameters.php") {
      const parameters = asRecord(asRecord(value)?.PARAMETERS);
      for (const [key, definition] of Object.entries(parameters ?? {})) {
        const spec = asRecord(definition);
        add({ featureType: "component_parameter", name: key, line: lineOf(node), detail: { name: spec?.NAME, type: spec?.TYPE, parent: spec?.PARENT, default: spec?.DEFAULT } });
      }
      return;
    }
    if (variable === "arComponentDescription" && fileName === ".description.php") {
      const description = asRecord(value);
      if (description) add({ featureType: "component_description", name: typeof description.NAME === "string" ? description.NAME : normalizedPath, line: lineOf(node), detail: { description: description.DESCRIPTION, path: description.PATH, complex: description.COMPLEX } });
      return;
    }
    if (value !== undefined) visitDefinitionArray(value, lineOf(node));
  };

  /** UF field and iblock property definitions, recognised by their characteristic keys. */
  const visitDefinitionArray = (value: unknown, line: number) => {
    const record = asRecord(value);
    if (!record) return;
    if (typeof record.FIELD_NAME === "string" && /^UF_/u.test(record.FIELD_NAME) && record.ENTITY_ID !== undefined) {
      add({ featureType: "user_field", name: record.FIELD_NAME, line, detail: { entityId: record.ENTITY_ID, type: record.USER_TYPE_ID, multiple: record.MULTIPLE } });
    } else if (typeof record.CODE === "string" && record.PROPERTY_TYPE !== undefined && record.IBLOCK_ID !== undefined) {
      add({ featureType: "iblock_property", name: record.CODE, line, detail: { iblockId: record.IBLOCK_ID, type: record.PROPERTY_TYPE, userType: record.USER_TYPE, name: record.NAME } });
    }
  };

  const visitCall = (node: Node, scope: Scope, routePrefix: string) => {
    const what = isNode(node.what) ? node.what : undefined;
    const args = (Array.isArray(node.arguments) ? node.arguments : []).filter(isNode);
    const argValue = (index: number) => literal(args[index], scope);
    for (const arg of args) visitDefinitionArray(literal(arg, scope), lineOf(node));

    // GetMessage('KEY') / Loc::getMessage('KEY')
    const functionName = what?.kind === "name" && typeof what.name === "string" ? what.name.replace(/^\\/u, "").toLowerCase() : undefined;
    const staticOwner = what?.kind === "staticlookup" ? resolveName(what.what, scope)?.toLowerCase() : undefined;
    const member = what && (what.kind === "staticlookup" || what.kind === "propertylookup" || what.kind === "nullsafepropertylookup") ? identifier(what.offset)?.toLowerCase() : undefined;
    const firstString = argValue(0);

    if ((functionName === "getmessage" || (staticOwner?.endsWith("\\loc") || staticOwner === "loc") && member === "getmessage") && typeof firstString === "string") {
      add({ featureType: "lang_usage", name: firstString, line: lineOf(node) });
    }
    if ((staticOwner === "bitrix\\main\\ui\\extension" && member === "load") || (staticOwner === "cjscore" && member === "init")) {
      const names = Array.isArray(firstString) ? firstString : [firstString];
      for (const name of names) if (typeof name === "string") add({ featureType: "js_extension_usage", name, line: lineOf(node) });
    }
    if (staticOwner === "cjscore" && member === "registerext" && typeof firstString === "string") {
      const config = asRecord(argValue(1));
      add({ featureType: "js_extension", name: firstString, line: lineOf(node), detail: { js: config?.js, css: config?.css, rel: config?.rel, legacy: true } });
    }
    if (staticOwner === "bitrix\\main\\loader" && member === "registerautoloadclasses") {
      const classes = asRecord(argValue(1));
      const ownerModule = typeof firstString === "string" ? firstString : undefined;
      for (const [className, file] of Object.entries(classes ?? {})) {
        add({ featureType: "autoload_class", name: className.replace(/^\\/u, ""), line: lineOf(node), target: typeof file === "string" ? file : undefined, ...(ownerModule ? { module: ownerModule } : {}) });
      }
    }
    if (staticOwner === "bitrix\\main\\loader" && member === "registernamespace" && typeof firstString === "string") {
      const directory = argValue(1);
      add({ featureType: "autoload_namespace", name: firstString.replace(/^\\/u, "").replace(/\\$/u, ""), line: lineOf(node), target: typeof directory === "string" ? directory : undefined });
    }

    if (isRestFile) {
      for (const arg of args) visitRestArray(literal(arg, scope), lineOf(node));
    }

    if (isRoutesFile) {
      visitRouteCall(node, scope, routePrefix);
    }
  };

  const visitRestArray = (value: unknown, line: number) => {
    const record = asRecord(value);
    if (!record) return;
    for (const [key, entry] of Object.entries(record)) {
      // Scope keys (e.g. 'vendor.crm') look like method names too; only entries with a callable are methods.
      const handler = REST_METHOD_NAME.test(key) ? callableTarget(entry) : undefined;
      if (handler) add({ featureType: "rest_method", name: key, line, target: handler });
      else visitRestArray(entry, line);
    }
  };

  /** `$routes->prefix('api')->name('api_')->group(fn)` / `$routes->get('/path', [Controller::class, 'action'])->name('x')`. */
  const visitRouteCall = (node: Node, scope: Scope, routePrefix: string) => {
    const chain: Array<{ method: string; args: Node[]; node: Node }> = [];
    let cursor: Node | undefined = node;
    while (cursor && cursor.kind === "call" && isNode(cursor.what) && (cursor.what.kind === "propertylookup" || cursor.what.kind === "nullsafepropertylookup")) {
      chain.unshift({ method: identifier(cursor.what.offset)?.toLowerCase() ?? "", args: (Array.isArray(cursor.arguments) ? cursor.arguments : []).filter(isNode), node: cursor });
      cursor = isNode(cursor.what.what) ? cursor.what.what : undefined;
    }
    if (chain.length === 0) {
      for (const child of children(node)) visit(child, scope, routePrefix);
      return;
    }
    let prefix = routePrefix;
    let routeName: string | undefined;
    const route = chain.find((link) => ROUTE_METHODS.has(link.method));
    for (const link of chain) {
      const first = literal(link.args[0], scope);
      if (link.method === "prefix" && typeof first === "string") prefix = joinRoute(prefix, first);
      if (link.method === "name" && typeof first === "string") routeName = first;
    }
    if (route) {
      const routePath = literal(route.args[0], scope);
      if (typeof routePath === "string") {
        const handlerNode = route.args[1];
        const handler = callableTarget(literal(handlerNode, scope)) ?? (isNode(handlerNode) && (handlerNode.kind === "closure" || handlerNode.kind === "arrowfunc") ? "closure" : undefined);
        add({ featureType: "route", name: `${route.method.toUpperCase()} ${joinRoute(routePrefix, routePath)}`, line: lineOf(route.node), target: handler, detail: routeName ? { routeName } : undefined });
      }
    }
    const group = chain.find((link) => link.method === "group");
    for (const link of chain) {
      for (const arg of link.args) visit(arg, scope, group && link === group ? prefix : routePrefix);
    }
  };

  const rootScope: Scope = { namespace: "", uses: new Map() };
  visit(ast, rootScope, "");
  return records;
}

function joinRoute(prefix: string, routePath: string): string {
  if (!prefix) return routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `/${[prefix, routePath].map((part) => part.replace(/^\/+|\/+$/gu, "")).filter(Boolean).join("/")}`;
}

function lineAt(source: string, index: number, lineStarts: number[]): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** A JS string literal whose quote is capture group `group` and whose body is group `group + 1`. */
function jsString(group: number): string {
  const backref = `\\${group}`;
  return `(['"\\x60])((?:\\\\.|(?!${backref}).)*)${backref}`;
}
const AJAX_ACTION = new RegExp(String.raw`BX\.ajax\.runAction\s*\(\s*` + jsString(1), "gu");
const AJAX_COMPONENT_ACTION = new RegExp(String.raw`BX\.ajax\.runComponentAction\s*\(\s*` + jsString(1) + String.raw`\s*,\s*` + jsString(3), "gu");
const JS_EVENT = new RegExp(String.raw`(?:BX\.addCustomEvent|BX\.Event\.EventEmitter\.subscribe|EventEmitter\.subscribe|BX\.onCustomEvent|BX\.Event\.EventEmitter\.emit|EventEmitter\.emit)\s*\(\s*(?:[\w.$]+\s*,\s*)?` + jsString(1), "gu");

/**
 * JS side of Bitrix features: AJAX calls to controller actions
 * (`BX.ajax.runAction('vendor:module.controller.action')`,
 * `BX.ajax.runComponentAction('vendor:component', 'action')`) and custom events
 * (`BX.addCustomEvent`, `EventEmitter.subscribe`/`emit`, `BX.onCustomEvent`).
 */
export function extractJsBitrixFeatures(source: string): BitrixFeatureRecord[] {
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) lineStarts.push(index + 1);
  const records: BitrixFeatureRecord[] = [];
  for (const match of source.matchAll(AJAX_ACTION)) {
    records.push({ featureType: "ajax_call", name: match[2], line: lineAt(source, match.index ?? 0, lineStarts), detail: { mode: "action" } });
  }
  for (const match of source.matchAll(AJAX_COMPONENT_ACTION)) {
    records.push({ featureType: "ajax_call", name: `${match[2]}::${match[4]}`, line: lineAt(source, match.index ?? 0, lineStarts), target: match[2], detail: { mode: "component", component: match[2], action: match[4] } });
  }
  for (const match of source.matchAll(JS_EVENT)) {
    const role = /emit|onCustomEvent/u.test(match[0]) ? "emit" : "subscribe";
    records.push({ featureType: "js_event", name: match[2], line: lineAt(source, match.index ?? 0, lineStarts), detail: { role } });
  }
  return records;
}
