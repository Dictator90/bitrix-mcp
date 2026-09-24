import fs from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type JSONPath, type ParseError } from "jsonc-parser";

export async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export type WriteOutcome = "created" | "updated" | "unchanged";

export interface WriteTextOptions {
  /** Write `<file>.bak` (once) before changing an existing file. */
  backup?: boolean;
  /** Current file content if already read, to avoid a second read. */
  previous?: string | undefined;
  mode?: number;
}

/** Path of the one-time backup written before bitrix-mcp first changes an existing config file. */
export function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

/**
 * Writes `next` only when it differs from the current content. When the file
 * already exists and `backup` is set, the original is first copied to
 * `<file>.bak` — only if no backup exists yet, so the very first pre-bitrix-mcp
 * version is the one that is kept.
 */
export async function writeTextIfChanged(filePath: string, next: string, options: WriteTextOptions = {}): Promise<WriteOutcome> {
  const previous = "previous" in options ? options.previous : await readTextFileIfExists(filePath);
  if (previous === next) {
    return "unchanged";
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (previous !== undefined && options.backup) {
    try {
      await fs.writeFile(backupPath(filePath), previous, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  await fs.writeFile(filePath, next, "utf8");
  if (options.mode !== undefined) {
    await fs.chmod(filePath, options.mode);
  }
  return previous === undefined ? "created" : "updated";
}

/**
 * A JSON/JSONC config file loaded for surgical editing: edits touch only the
 * paths we manage, so comments, formatting, and unrelated keys survive.
 */
export interface JsonConfigDocument {
  filePath: string;
  /** Content on disk, or undefined when the file does not exist. */
  original: string | undefined;
  text: string;
  value: Record<string, unknown>;
  formatting: FormattingOptions;
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true };

function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = /^([ \t]+)\S/m.exec(text);
  if (indentMatch?.[1].startsWith("\t")) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  return { insertSpaces: true, tabSize: indentMatch ? Math.min(indentMatch[1].length, 8) : 2, eol };
}

function parseErrorsMessage(filePath: string, text: string, errors: ParseError[]): string {
  const first = errors[0];
  const before = text.slice(0, first.offset);
  const line = before.split("\n").length;
  const column = first.offset - before.lastIndexOf("\n");
  return `Cannot parse ${filePath}: ${printParseErrorCode(first.error)} at line ${line}, column ${column}. ` +
    "bitrix-mcp did not modify it; fix the file (or move it away) and re-run.";
}

function parseObject(filePath: string, text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, PARSE_OPTIONS) as unknown;
  if (errors.length > 0) {
    throw new Error(parseErrorsMessage(filePath, text, errors));
  }
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config ${filePath} must contain a JSON object; bitrix-mcp did not modify it.`);
  }
  return value as Record<string, unknown>;
}

export async function loadJsonConfig(filePath: string): Promise<JsonConfigDocument> {
  const original = await readTextFileIfExists(filePath);
  const text = original !== undefined && original.trim() ? original : "{}";
  return { filePath, original, text, value: parseObject(filePath, text), formatting: detectFormatting(original ?? "") };
}

function tryModify(doc: JsonConfigDocument, jsonPath: JSONPath, value: unknown): string | undefined {
  const next = applyEdits(doc.text, modify(doc.text, jsonPath, value, { formattingOptions: doc.formatting }));
  const errors: ParseError[] = [];
  parse(next, errors, PARSE_OPTIONS);
  return errors.length === 0 ? next : undefined;
}

function valueAt(root: unknown, jsonPath: JSONPath): unknown {
  let current = root;
  for (const segment of jsonPath) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function withChange(container: unknown, key: string | number, value: unknown): unknown {
  if (Array.isArray(container)) {
    const copy = [...container];
    if (value === undefined) copy.splice(Number(key), 1);
    else copy[Number(key)] = value;
    return copy;
  }
  const copy: Record<string, unknown> = { ...(container as Record<string, unknown>) };
  if (value === undefined) delete copy[String(key)];
  else copy[String(key)] = value;
  return copy;
}

/**
 * Sets (or, with `undefined`, removes) the value at `jsonPath`. jsonc-parser's
 * minimal edit can produce invalid text next to trailing commas; in that case
 * the edit is retried one level up (rewriting just the parent), and as a last
 * resort the whole document is re-serialized.
 */
export function setJsonValue(doc: JsonConfigDocument, jsonPath: JSONPath, value: unknown): void {
  const current = valueAt(doc.value, jsonPath);
  if (value === undefined ? current === undefined : JSON.stringify(current) === JSON.stringify(value)) {
    return;
  }
  let next = tryModify(doc, jsonPath, value);
  if (next === undefined && jsonPath.length > 1) {
    const parentPath = jsonPath.slice(0, -1);
    const parent = valueAt(doc.value, parentPath);
    if (parent && typeof parent === "object") {
      next = tryModify(doc, parentPath, withChange(parent, jsonPath[jsonPath.length - 1], value));
    }
  }
  if (next === undefined) {
    const updated = jsonPath.length === 0
      ? value
      : setDeep(structuredClone(doc.value), jsonPath, value);
    next = `${JSON.stringify(updated ?? {}, null, doc.formatting.insertSpaces === false ? "\t" : doc.formatting.tabSize ?? 2)}\n`;
  }
  doc.text = next;
  doc.value = parseObject(doc.filePath, next);
}

function setDeep(root: Record<string, unknown>, jsonPath: JSONPath, value: unknown): Record<string, unknown> {
  let current: Record<string | number, unknown> = root;
  for (const segment of jsonPath.slice(0, -1)) {
    const child = current[segment];
    if (!child || typeof child !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string | number, unknown>;
  }
  const last = jsonPath[jsonPath.length - 1];
  if (value === undefined) delete current[last];
  else current[last] = value;
  return root;
}

export function getJsonValue(doc: JsonConfigDocument, jsonPath: JSONPath): unknown {
  return valueAt(doc.value, jsonPath);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Final text to write: keeps a trailing newline. */
export function jsonConfigText(doc: JsonConfigDocument): string {
  return doc.text.endsWith("\n") ? doc.text : `${doc.text}${doc.formatting.eol ?? "\n"}`;
}

export async function saveJsonConfig(doc: JsonConfigDocument): Promise<WriteOutcome> {
  if (doc.original !== undefined && doc.text === doc.original) {
    return "unchanged";
  }
  return writeTextIfChanged(doc.filePath, jsonConfigText(doc), { backup: true, previous: doc.original });
}

/** True when a value holds no data: only (nested) empty objects/arrays. */
export function isEffectivelyEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isEffectivelyEmpty);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(isEffectivelyEmpty);
  }
  return false;
}

// ---------------------------------------------------------------------------
// TOML (Codex): line-based table block replacement.
// ---------------------------------------------------------------------------

interface TomlHeader {
  line: number;
  segments: string[];
}

/** Splits a TOML dotted key (`a."b.c".'d'`) into unquoted segments. */
export function splitTomlKey(key: string): string[] | undefined {
  const segments: string[] = [];
  let index = 0;
  const source = key.trim();
  while (index < source.length) {
    while (source[index] === " " || source[index] === "\t") index += 1;
    const quote = source[index];
    let segment = "";
    if (quote === "\"" || quote === "'") {
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (quote === "\"" && source[index] === "\\" && index + 1 < source.length) {
          segment += source[index + 1];
          index += 2;
          continue;
        }
        segment += source[index];
        index += 1;
      }
      if (source[index] !== quote) return undefined;
      index += 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return undefined;
      segment = match[0];
      index += segment.length;
    }
    segments.push(segment);
    while (source[index] === " " || source[index] === "\t") index += 1;
    if (index >= source.length) break;
    if (source[index] !== ".") return undefined;
    index += 1;
  }
  return segments.length > 0 ? segments : undefined;
}

const TOML_HEADER = /^\s*(\[\[?)\s*((?:[^\]"'#]|"(?:[^"\\]|\\.)*"|'[^']*')+?)\s*(\]\]?)\s*(?:#.*)?$/;

/** Finds `[table]` / `[[array]]` header lines, skipping multi-line strings. */
function findTomlHeaders(lines: string[]): TomlHeader[] {
  const headers: TomlHeader[] = [];
  let inMultiline: string | undefined;
  lines.forEach((line, index) => {
    for (const delimiter of ["\"\"\"", "'''"]) {
      if (inMultiline && inMultiline !== delimiter) continue;
      const count = line.split(delimiter).length - 1;
      if (count % 2 === 1) {
        inMultiline = inMultiline ? undefined : delimiter;
      }
    }
    if (inMultiline) return;
    const match = TOML_HEADER.exec(line);
    if (!match || (match[1] === "[[") !== (match[3] === "]]")) return;
    const segments = splitTomlKey(match[2]);
    if (segments) headers.push({ line: index, segments });
  });
  return headers;
}

function startsWithSegments(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment);
}

/**
 * Removes the `[<table>]` block and all of its sub-tables (`[<table>.env]`,
 * `[[<table>.x]]`, ...), then optionally inserts `block` where the table was
 * (or appends it). Other tables, comments and formatting are kept.
 */
export function replaceTomlTable(source: string, table: string[], block: string | undefined): string {
  const lines = source.split(/\r?\n/);
  const headers = findTomlHeaders(lines);
  const removed = new Set<number>();
  let insertAt: number | undefined;
  headers.forEach((header, index) => {
    if (!startsWithSegments(header.segments, table)) return;
    let end = index + 1 < headers.length ? headers[index + 1].line : lines.length;
    // Blank/comment lines right before the next header belong to that header.
    if (index + 1 < headers.length) {
      while (end - 1 > header.line && /^\s*(#.*)?$/.test(lines[end - 1])) end -= 1;
    }
    insertAt ??= header.line;
    for (let line = header.line; line < end; line += 1) removed.add(line);
  });

  if (insertAt === undefined) {
    if (block === undefined) return source;
    return `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${block}\n`;
  }

  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (index === insertAt && block !== undefined) kept.push(...block.split("\n"), "");
    if (!removed.has(index)) kept.push(line);
  });
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text ? `${text}\n` : "";
}

/** Whether the TOML source has a `[<table>]` header (quoted or bare keys). */
export function hasTomlTable(source: string, table: string[]): boolean {
  return findTomlHeaders(source.split(/\r?\n/)).some((header) => startsWithSegments(header.segments, table));
}
