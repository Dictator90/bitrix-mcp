import { parseArgs } from "node:util";

/** Invalid command-line usage (unknown command/option, bad value). Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface OptionDef {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  /** Placeholder shown in help for string options. */
  value?: string;
  description: string;
}

/** Every option any command accepts. Commands pick the subset they support. */
const OPTIONS: Record<string, OptionDef> = {
  force: { type: "boolean", description: "Reindex even when files look unchanged" },
  json: { type: "boolean", description: "Print machine-readable JSON" },
  verbose: { type: "boolean", description: "Include config diagnostics" },
  embeddings: { type: "boolean", description: "Also send indexed docs to the embeddings service" },

  // Progress
  progress: { type: "boolean", description: "Force progress output (useful for non-TTY)" },
  "no-progress": { type: "boolean", description: "Disable progress output" },
  compact: { type: "boolean", description: "Compact progress with dots and checkmarks" },
  "json-progress": { type: "boolean", description: "Emit JSON Lines progress events to stderr" },

  // Bitrix scope
  modules: { type: "string", value: "main,iblock", description: "Index only these Bitrix core modules (default: all)" },
  "bitrix-modules": { type: "string", value: "main,iblock", description: "Alias for --modules" },
  full: { type: "boolean", description: "Every module plus lang and install assets (slow)" },
  "include-lang": { type: "boolean", description: "Include lang/ message files" },
  "exclude-lang": { type: "boolean", description: "Exclude lang/ message files (default)" },
  install: { type: "boolean", description: "Also index module install/ assets" },
  "no-bitrix": { type: "boolean", description: "Skip the Bitrix core and install scopes" },
  plan: { type: "boolean", description: "Print what would be indexed without indexing" },

  // init / configure / uninstall
  agent: { type: "string", multiple: true, value: "id", description: "Agent to configure (repeat or comma-separate)" },
  "all-agents": { type: "boolean", description: "Select all built-in agents" },
  yes: { type: "boolean", short: "y", description: "Non-interactive defaults (configures Cursor unless --agent is given)" },
  "no-index": { type: "boolean", description: "Skip code indexing during init" },
  "no-docs": { type: "boolean", description: "Skip documentation indexing during init" },
  "no-official-docs": { type: "boolean", description: "Do not clone/pull the official Bitrix docs" },
  serve: { type: "boolean", description: "Start the stdio server after init" },
  "no-serve": { type: "boolean", description: "Do not start the server after init (default)" },
  "no-db": { type: "boolean", description: "Disable project DB access in the generated config" },
  "db-allow-write": { type: "boolean", description: "Allow DB writes in the generated config" },
  tinker: { type: "boolean", description: "Enable bitrix_tinker (arbitrary PHP execution)" },
  "php-bin": { type: "string", value: "path", description: "PHP CLI binary for bitrix_tinker" },
  "no-hooks": { type: "boolean", description: "Do not write agent context-injection hooks" },
  "dry-run": { type: "boolean", description: "Print what would change without changing anything" },

  // watch / clean
  docs: { type: "boolean", description: "Also watch documentation directories and re-index docs" },
  debounce: { type: "string", value: "ms", description: "Quiet period before re-indexing a batch of changes (default 500)" },
  all: { type: "boolean", description: "Also remove the docs-sources/ documentation checkouts" },

  // detect-changes / graph
  base: { type: "string", value: "ref", description: "Git base ref to diff against" },
  kind: { type: "string", value: "kinds", description: "Only these file kinds (comma-separated)" },
  "include-source": { type: "boolean", description: "Include source excerpts" },
  "no-relations": { type: "boolean", description: "Skip relation analysis" },
  "no-impact": { type: "boolean", description: "Skip impact analysis" },
  "no-symbol-diff": { type: "boolean", description: "Skip the symbol-level diff of changed files" },
  "diff-baseline": { type: "string", value: "mode", description: "Symbol diff before state: auto, index, or git" },
  "no-risk": { type: "boolean", description: "Skip risk scoring" },
  "no-symbols": { type: "boolean", description: "Skip changed-symbol detection" },
  depth: { type: "string", value: "n", description: "Traversal depth (integer >= 0)" },
  "max-files": { type: "string", value: "n", description: "Maximum files to analyze (integer >= 1)" },
  "max-items": { type: "string", value: "n", description: "Maximum items per section (integer >= 1)" },
  limit: { type: "string", value: "n", description: "Maximum results (integer >= 1)" },
  direction: { type: "string", value: "out|in|both", description: "Edge direction" },
  "relation-type": { type: "string", value: "type", description: "Only this relation type" },
  "relation-types": { type: "string", value: "types", description: "Only these relation types (comma-separated)" }
};

const PROGRESS = ["progress", "no-progress", "compact", "json-progress"];
const LANG = ["include-lang", "exclude-lang"];
const BITRIX = ["modules", "bitrix-modules", "full", ...LANG, "install", "no-bitrix"];
const INIT = ["agent", "all-agents", "yes", "no-index", "no-docs", "no-official-docs", "serve", "no-serve", "no-db", "db-allow-write", "tinker", "php-bin", "no-hooks", "dry-run"];

interface CommandSpec {
  synopsis: string;
  summary: string;
  options: string[];
  /** Maximum positional arguments after the command (Infinity for lists). */
  maxPositionals: number;
}

export const COMMANDS: Record<string, CommandSpec> = {
  init: { synopsis: "init [options]", summary: "Configure MCP clients and index the project/docs.", options: INIT, maxPositionals: 0 },
  configure: { synopsis: "configure [options]", summary: "Configure MCP clients and guidance only (no indexing or server).", options: INIT, maxPositionals: 0 },
  uninstall: { synopsis: "uninstall [--agent <id>] [--all-agents] [--dry-run]", summary: "Remove the MCP config entries, hooks, guidance sections, and skills written by init/configure.", options: ["agent", "all-agents", "dry-run"], maxPositionals: 0 },
  config: { synopsis: "config [--json]", summary: "Show resolved runtime paths and MCP client config file presence.", options: ["json"], maxPositionals: 0 },
  serve: { synopsis: "serve", summary: "Start the MCP server over stdio.", options: [], maxPositionals: 0 },
  watch: { synopsis: "watch [options]", summary: "Watch the workspace (and Bitrix root) and incrementally re-index changed files until Ctrl+C.", options: [...BITRIX, "docs", "debounce", "json"], maxPositionals: 0 },
  clean: { synopsis: "clean [--dry-run] [--yes] [--all]", summary: "Remove index data from the data directory (SQLite index, legacy JSON indexes, benchmark reports).", options: ["dry-run", "yes", "all"], maxPositionals: 0 },
  "index-all": { synopsis: "index-all [options]", summary: "Index project, templates, Bitrix modules, and docs.", options: ["force", ...BITRIX, ...PROGRESS], maxPositionals: 0 },
  "index-code": { synopsis: "index-code [options]", summary: "Index project, templates, and Bitrix modules.", options: ["force", ...BITRIX, ...PROGRESS], maxPositionals: 0 },
  "index-project": { synopsis: "index-project [root] [options]", summary: "Index project files.", options: ["force", ...LANG, ...PROGRESS], maxPositionals: 1 },
  "index-template": { synopsis: "index-template [templatePath] [options]", summary: "Index a template path, or standard template locations.", options: ["force", ...LANG, ...PROGRESS], maxPositionals: 1 },
  "index-bitrix": { synopsis: "index-bitrix [root] [options]", summary: "Index the Bitrix core (modules/admin/tools/js).", options: ["force", ...BITRIX, "plan", ...PROGRESS], maxPositionals: 1 },
  "index-install": { synopsis: "index-install [root] [options]", summary: "Index Bitrix module install assets.", options: ["force", ...LANG, ...PROGRESS], maxPositionals: 1 },
  "docs-add-git": { synopsis: "docs-add-git [url]", summary: "Register a Git documentation source (defaults to the official Bitrix docs).", options: [], maxPositionals: 1 },
  "docs-add-path": { synopsis: "docs-add-path <path>", summary: "Register a local documentation directory.", options: [], maxPositionals: 1 },
  "docs-update": { synopsis: "docs-update", summary: "Clone or pull registered Git documentation sources.", options: [], maxPositionals: 0 },
  "index-docs": { synopsis: "index-docs [--force] [--embeddings]", summary: "Index registered documentation sources into SQLite.", options: ["force", "embeddings", ...PROGRESS], maxPositionals: 0 },
  "index-embeddings": { synopsis: "index-embeddings", summary: "Send SQLite documentation chunks to the embeddings service.", options: [], maxPositionals: 0 },
  "search-modules": { synopsis: "search-modules <module>", summary: "Search indexed Bitrix module include/check API usages.", options: [], maxPositionals: 1 },
  status: { synopsis: "status", summary: "Show the SQLite DB path and index counters.", options: [], maxPositionals: 0 },
  doctor: { synopsis: "doctor [--json] [--verbose]", summary: "Check workspace, Bitrix root, SQLite, docs, ignore file, and embeddings.", options: ["json", "verbose"], maxPositionals: 0 },
  "detect-changes": { synopsis: "detect-changes [options]", summary: "Analyze Git-changed Bitrix files, indexed entities, and impact.", options: ["base", "kind", "include-source", "no-relations", "no-impact", "no-risk", "no-symbol-diff", "diff-baseline", "depth", "max-files", "max-items", "full", "json"], maxPositionals: 0 },
  "graph-neighbors": { synopsis: "graph-neighbors <type> <name> [options]", summary: "Query direct neighbors in the dependency graph (JSON output).", options: ["direction", "relation-type", "depth", "limit", "full", "json"], maxPositionals: 2 },
  "impact-radius": { synopsis: "impact-radius [file ...] [options]", summary: "Analyze Bitrix graph impact radius (JSON output).", options: ["base", "depth", "relation-types", "no-symbols", "no-risk", "limit", "full", "json"], maxPositionals: Number.POSITIVE_INFINITY },
  benchmark: { synopsis: "benchmark [--force]", summary: "Generate .bitrix-mcp/benchmark.json and benchmark.md.", options: ["force"], maxPositionals: 0 }
};

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

export type ParsedCli =
  | { kind: "usage" }
  | { kind: "version" }
  | { kind: "help"; command: string }
  | { kind: "command"; command: string; values: OptionValues; positionals: string[] };

const GLOBAL_FLAGS = new Set(["--help", "-h", "--version", "-v", "--debug"]);

function unknownOptionName(message: string): string | undefined {
  return /'(-[^']*)'/.exec(message)?.[1];
}

/**
 * Parses `bitrix-mcp [global flags] <command> [options] [args]` with
 * `node:util` parseArgs in strict mode, per command. Both `--opt value` and
 * `--opt=value` work; unknown options throw a UsageError. `--help`/`-h` after
 * a command always short-circuits to that command's help.
 */
export function parseCli(argv: string[]): ParsedCli {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
  const globals = commandIndex === -1 ? argv : argv.slice(0, commandIndex);
  for (const arg of globals) {
    if (!GLOBAL_FLAGS.has(arg)) {
      throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  if (globals.includes("--version") || globals.includes("-v")) {
    return { kind: "version" };
  }
  if (commandIndex === -1) {
    return { kind: "usage" };
  }

  const command = argv[commandIndex];
  const spec = COMMANDS[command];
  if (!spec) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  const rest = argv.slice(commandIndex + 1);
  const terminator = rest.indexOf("--");
  const beforeTerminator = terminator === -1 ? rest : rest.slice(0, terminator);
  if (globals.includes("--help") || globals.includes("-h") || beforeTerminator.includes("--help") || beforeTerminator.includes("-h")) {
    return { kind: "help", command };
  }

  const options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = { debug: { type: "boolean" } };
  for (const name of spec.options) {
    const { type, short, multiple } = OPTIONS[name];
    options[name] = { type, ...(short ? { short } : {}), ...(multiple ? { multiple } : {}) };
  }

  let parsed: { values: OptionValues; positionals: string[] };
  try {
    parsed = parseArgs({ args: rest, options, strict: true, allowPositionals: true }) as { values: OptionValues; positionals: string[] };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new UsageError(`Unknown option for "${command}": ${unknownOptionName(message) ?? message}. Run "bitrix-mcp ${command} --help" to list its options.`);
    }
    throw new UsageError(`${command}: ${message}`);
  }

  if (parsed.positionals.length > spec.maxPositionals) {
    const extra = parsed.positionals[spec.maxPositionals];
    throw new UsageError(`Unexpected argument for "${command}": ${extra}. Usage: bitrix-mcp ${spec.synopsis}`);
  }
  for (const name of spec.options) {
    const value = parsed.values[name];
    if (OPTIONS[name].type === "string" && typeof value === "string" && value.trim() === "") {
      throw new UsageError(`--${name} requires a value.`);
    }
  }
  return { kind: "command", command, values: parsed.values, positionals: parsed.positionals };
}

/** Reads an integer option, rejecting non-numeric or out-of-range values. */
export function integerOption(values: OptionValues, name: string, min = 0): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text) || Number(text) < min) {
    throw new UsageError(`--${name} must be an integer >= ${min}, got "${String(raw)}".`);
  }
  return Number(text);
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function listOption(values: OptionValues, name: string): string[] {
  const value = values[name];
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

export function flag(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

export function commandHelp(command: string): string {
  const spec = COMMANDS[command];
  const rows: Array<[string, string]> = spec.options.map((name) => {
    const option = OPTIONS[name];
    const short = option.short ? `-${option.short}, ` : "";
    const value = option.type === "string" ? (name === "modules" || name === "bitrix-modules" ? `=${option.value}` : ` <${option.value}>`) : "";
    return [`${short}--${name}${value}`, option.description];
  });
  rows.push(["-h, --help", "Show this help and exit"], ["--debug", "Print the stack trace when the command fails"]);
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return [
    `Usage: bitrix-mcp ${spec.synopsis}`,
    "",
    spec.summary,
    "",
    "Options:",
    ...rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`),
    "",
    "Value options accept both --name value and --name=value. Run bitrix-mcp --help for all commands."
  ].join("\n");
}
