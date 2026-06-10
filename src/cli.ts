#!/usr/bin/env node
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { collectConfigDiagnostics, formatConfigDiagnostics } from "./config/diagnostics.js";
import { indexPath, resolveBitrixProjectRoot, resolveRuntimePaths, sqlitePath } from "./config/paths.js";
import { detectChanges, formatDetectChangesText, type DetectChangesOptions } from "./indexer/detectChanges.js";
import { getGraphNeighbors, getImpactRadiusForPaths, type GraphNeighborsOptions, type ImpactRadiusOptions } from "./indexer/graph.js";
import { buildIndex, discoverFiles } from "./indexer/indexer.js";
import { resolveBitrixIndex, parseModuleSelection, validateBitrixModules, detectBitrixModule, type BitrixModuleSelection } from "./indexer/bitrixModules.js";
import { searchModuleUsages } from "./indexer/sqliteStore.js";
import { formatDoctor, formatIndexAllResult, formatIndexEmbeddingsResult, formatIndexStatus, hasDoctorErrors, indexAll, indexCode, indexEmbeddings, installIndexOptions, readIndexStatus, runDoctor } from "./indexer/actions.js";
import { resolveTemplateIndexOptions } from "./indexer/template.js";
import { configureAgents, initAndServe, parseAgentIds, type InitOptions } from "./init/init.js";
import { addGitDocSource, addPathDocSource, indexDocResourcesToSqlite, OFFICIAL_DOCS_GIT_URL, updateDocSources } from "./resources/docs.js";
import { serveStdio } from "./mcp/server.js";
import { runBenchmark } from "./benchmark/report.js";
import { formatModuleUsageSearchResults } from "./mcp/format.js";
import { createProgressReporter, detectCi, type CreateProgressReporterOptions } from "./progress/index.js";

function readVersion(): string {
  try {
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(nodePath.join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function usage(): string {
  return `Usage: bitrix-mcp <command> [options]

Global options:
  --version, -v                 Print the installed bitrix-mcp version and exit
  --help, -h                    Show this help and exit

Commands:
  init [options]                Configure MCP clients and index the project/docs (the MCP client starts the server; use --serve to start it now)
  configure [options]           Configure MCP clients and guidance only (no indexing or server)
  config [--json]               Show resolved runtime paths and MCP client config file presence
  serve                         Start MCP server over stdio
  index-all [--force]           Index project, templates, Bitrix modules, install assets, and docs
  index-code [--force]          Index project, templates, Bitrix modules, and install assets
  index-project [root] [--force] Index project files
  index-template [templatePath] [--force] Index a specific template path, or standard template locations
  index-bitrix [root] [options]  Index Bitrix core (modules/admin/tools/js). See Bitrix indexing options
  index-install [root] [--force] Index Bitrix module install assets
  docs-add-git [url]            Register a Git documentation source (defaults to official Bitrix docs)
  docs-add-path <path>          Register a local documentation directory
  docs-update                   Clone or pull registered Git documentation sources
  index-docs [--force] [--embeddings] Index registered documentation sources into SQLite, optionally then into embeddings
  index-embeddings              Send SQLite documentation chunks to the embeddings service
  search-modules <module>       Search indexed Bitrix module include/check API usages
  status                        Show SQLite DB path and index counters
  doctor [--json] [--verbose]   Check workspace, Bitrix root, SQLite, docs, ignore file, and semantic embeddings when enabled
  detect-changes [--base <ref>] [--json] [--depth <n>] Analyze Git-changed Bitrix files, indexed entities, and impact
  graph-neighbors <type> <name> [--direction out|in|both] [--relation-type <type>] [--depth <n>] [--json]
  impact-radius [file ...] [--base <ref>] [--depth <n>] [--json] Analyze Bitrix graph impact radius
  benchmark [--force]           Generate .bitrix-mcp/benchmark.json and benchmark.md

Bitrix indexing options (index-bitrix; index-code/index-all accept --no-bitrix, --modules, --include-lang, --install, --full):
  --modules=main,iblock         Index only these Bitrix core modules (default: all). Use --modules=all for every module
  --full                        Index every module plus lang and install assets (slow). Alias for --modules=all --include-lang --install
  --include-lang                Include lang/ message files (excluded by default in every scope)
  --install                     index-code/index-all only: also index module install/ assets (excluded by default)
  --no-bitrix                   index-code/index-all only: skip the Bitrix core and install scopes entirely
  --plan                        index-bitrix only: print what would be indexed (files found/ignored/queued) without indexing
                                The Bitrix core scope indexes modules + admin + tools + js; runtime, static assets,
                                install and lang are excluded by default. Components/templates are the template scope.

Indexing progress options (index-* commands):
  --progress                    Force progress output (useful for non-TTY)
  --no-progress                 Disable progress output
  --compact                     Compact progress with dots and checkmarks
  --json-progress               Emit JSON Lines progress events to stderr
                                Progress is on by default in an interactive terminal,
                                always written to stderr, and off in CI/non-TTY.

Init/configure options:
  --agent <id>                  Configure an agent non-interactively (repeat or comma-separate)
  --all-agents                  Configure all built-in agents that do not need extra prompts
  --no-index                    Skip project/template/Bitrix code indexing during init
  --no-docs                     Skip documentation indexing during init
  --no-official-docs            Do not clone/pull official Bitrix docs during init docs indexing
  --no-serve                    Do not start stdio server after init (this is the default)
  --serve                       Start the stdio server after init (normally the MCP client starts it)
  --yes                         Accept defaults for non-interactive init/configure (Cursor)

Agent IDs: cursor, claude-desktop, claude-code, jetbrains, vscode, windsurf, cline, roo-code, continue, gemini-cli, codex, kilo-code, generic-json

Environment:
  BITRIX_MCP_DATA_DIR           Directory for generated indexes
  BITRIX_MCP_DOCS_PATHS         Documentation directories separated by the platform path delimiter
  BITRIX_MCP_DOCS_DIR           Legacy directory with local Bitrix documentation
  BITRIX_MCP_EMBEDDINGS_URL     Python embeddings service URL
  BITRIX_MCP_SEMANTIC_ENABLED   Enable optional semantic MCP tool (1/true/yes/on)
  BITRIX_MCP_OFFICIAL_DOCS_ENABLED Auto-register/update official Bitrix docs during docs indexing (default on)
  BITRIX_ROOT                   Bitrix project root for LiveAPI indexing
`;
}

function parseInitOptions(argv: string[]): InitOptions {
  const agentValues: string[] = [];
  const options: InitOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--agent") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--agent requires an agent id.");
      }
      agentValues.push(next);
      index += 1;
    } else if (value.startsWith("--agent=")) {
      agentValues.push(value.slice("--agent=".length));
    } else if (value === "--all-agents") {
      options.allAgents = true;
    } else if (value === "--no-index") {
      options.index = false;
    } else if (value === "--no-docs") {
      options.docs = false;
    } else if (value === "--no-official-docs") {
      options.officialDocs = false;
    } else if (value === "--no-serve") {
      options.serve = false;
    } else if (value === "--serve") {
      options.serve = true;
    } else if (value === "--yes" || value === "-y") {
      options.yes = true;
    }
  }

  if (agentValues.length > 0) {
    const agents = parseAgentIds(agentValues);
    if (agents.length === 0) {
      throw new Error(`Unknown agent id for --agent: ${agentValues.join(", ")}`);
    }
    options.agents = agents;
  }

  return options;
}

function parseDetectChangesOptions(argv: string[]): DetectChangesOptions {
  const options: DetectChangesOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--base requires a git ref.");
      options.base = next;
      index += 1;
    } else if (value.startsWith("--base=")) {
      options.base = value.slice("--base=".length);
    } else if (value === "--kind") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--kind requires a file kind.");
      options.kind = next.split(",").map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (value.startsWith("--kind=")) {
      options.kind = value.slice("--kind=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (value === "--include-source") {
      options.includeSource = true;
    } else if (value === "--no-relations") {
      options.includeRelations = false;
    } else if (value === "--no-impact") {
      options.includeImpact = false;
    } else if (value === "--no-risk") {
      options.includeRisk = false;
    } else if (value === "--depth") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--depth requires a number.");
      options.maxDepth = Number(next);
      index += 1;
    } else if (value.startsWith("--depth=")) {
      options.maxDepth = Number(value.slice("--depth=".length));
    } else if (value === "--max-files") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--max-files requires a number.");
      options.maxFiles = Number(next);
      index += 1;
    } else if (value.startsWith("--max-files=")) {
      options.maxFiles = Number(value.slice("--max-files=".length));
    } else if (value === "--max-items") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--max-items requires a number.");
      options.maxItems = Number(next);
      index += 1;
    } else if (value.startsWith("--max-items=")) {
      options.maxItems = Number(value.slice("--max-items=".length));
    } else if (value === "--full") {
      options.format = "full";
    }
  }
  return options;
}

function parseGraphNeighborsOptions(argv: string[]): GraphNeighborsOptions {
  const options: GraphNeighborsOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--direction") {
      const next = argv[index + 1];
      if (next !== "out" && next !== "in" && next !== "both") throw new Error("--direction must be out, in, or both.");
      options.direction = next;
      index += 1;
    } else if (value.startsWith("--direction=")) {
      const next = value.slice("--direction=".length);
      if (next !== "out" && next !== "in" && next !== "both") throw new Error("--direction must be out, in, or both.");
      options.direction = next;
    } else if (value === "--relation-type") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--relation-type requires a value.");
      options.relationType = next;
      index += 1;
    } else if (value.startsWith("--relation-type=")) {
      options.relationType = value.slice("--relation-type=".length);
    } else if (value === "--depth") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--depth requires a number.");
      options.depth = Number(next);
      index += 1;
    } else if (value.startsWith("--depth=")) {
      options.depth = Number(value.slice("--depth=".length));
    } else if (value === "--limit") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--limit requires a number.");
      options.limit = Number(next);
      index += 1;
    } else if (value.startsWith("--limit=")) {
      options.limit = Number(value.slice("--limit=".length));
    } else if (value === "--full") {
      options.format = "full";
    }
  }
  return options;
}

function parseImpactRadiusOptions(argv: string[], files: string[]): ImpactRadiusOptions {
  const options: ImpactRadiusOptions = { files: files.length > 0 ? files : undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--base requires a git ref.");
      options.base = next;
      index += 1;
    } else if (value.startsWith("--base=")) {
      options.base = value.slice("--base=".length);
    } else if (value === "--depth") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--depth requires a number.");
      options.maxDepth = Number(next);
      index += 1;
    } else if (value.startsWith("--depth=")) {
      options.maxDepth = Number(value.slice("--depth=".length));
    } else if (value === "--relation-types") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--relation-types requires a comma-separated list.");
      options.relationTypes = next.split(",").map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (value.startsWith("--relation-types=")) {
      options.relationTypes = value.slice("--relation-types=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (value === "--no-symbols") {
      options.includeChangedSymbols = false;
    } else if (value === "--no-risk") {
      options.includeRisk = false;
    } else if (value === "--limit") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--limit requires a number.");
      options.limit = Number(next);
      index += 1;
    } else if (value.startsWith("--limit=")) {
      options.limit = Number(value.slice("--limit=".length));
    } else if (value === "--full") {
      options.format = "full";
    }
  }
  return options;
}

function parseProgressOptions(argv: string[]): CreateProgressReporterOptions {
  const options: CreateProgressReporterOptions = {
    stderr: process.stderr,
    isTty: Boolean(process.stderr.isTTY),
    isCi: detectCi()
  };
  if (argv.includes("--no-progress")) {
    options.progress = false;
  } else if (argv.includes("--progress")) {
    options.progress = true;
  }
  if (argv.includes("--compact")) {
    options.compact = true;
  }
  if (argv.includes("--json-progress")) {
    options.jsonProgress = true;
  }
  return options;
}

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = argv.find((value) => value.startsWith(prefix));
  return hit?.slice(prefix.length);
}

interface BitrixCliOptions {
  modules: BitrixModuleSelection;
  includeLang: boolean;
  includeInstall: boolean;
  full: boolean;
  plan: boolean;
  noBitrix: boolean;
}

function parseBitrixOptions(argv: string[]): BitrixCliOptions {
  const full = argv.includes("--full");
  const plan = argv.includes("--plan");
  const noBitrix = argv.includes("--no-bitrix");
  let includeLang = argv.includes("--include-lang");
  if (argv.includes("--exclude-lang")) {
    includeLang = false;
  }
  let includeInstall = argv.includes("--install");
  let modules: BitrixModuleSelection = parseModuleSelection(flagValue(argv, "--modules") ?? flagValue(argv, "--bitrix-modules")) ?? "all";
  if (full) {
    modules = "all";
    includeLang = true;
    includeInstall = true;
  }
  return { modules, includeLang, includeInstall, full, plan, noBitrix };
}

async function printBitrixPlan(projectRoot: string, resolved: ReturnType<typeof resolveBitrixIndex>, modules: BitrixModuleSelection): Promise<void> {
  const { found, queued } = await discoverFiles(projectRoot, { kind: "bitrix", patterns: resolved.patterns, ignores: resolved.ignores, includeLang: resolved.includeLang });
  const byModule = new Map<string, number>();
  for (const relativePath of queued) {
    const moduleName = detectBitrixModule(relativePath) ?? "(core: admin/tools/js)";
    byModule.set(moduleName, (byModule.get(moduleName) ?? 0) + 1);
  }
  const top = [...byModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log([
    "Bitrix indexing plan",
    "",
    `Root: ${nodePath.join(projectRoot, "bitrix")}`,
    `Modules: ${modules === "all" ? "all" : modules.join(", ")}`,
    `Lang files: ${resolved.includeLang ? "included" : "excluded"}`,
    "",
    `Files found:  ${found.length}`,
    `Files ignored: ${found.length - queued.length}`,
    `Files queued: ${queued.length}`,
    "",
    "Top queued modules:",
    ...top.map(([moduleName, count]) => `- ${moduleName}: ${count} files`)
  ].join("\n"));
}

function positionalArgs(argv: string[]): string[] {
  const result: string[] = [];
  const optionsWithValues = new Set(["--agent", "--base", "--kind", "--max-files", "--max-items", "--direction", "--relation-type", "--depth", "--limit", "--relation-types"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      continue;
    }
    result.push(value);
  }
  return result;
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const embeddings = argv.includes("--embeddings");
  const positional = positionalArgs(argv).filter((value) => value !== "-y");
  const [command, arg] = positional;
  const paths = resolveRuntimePaths();

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readVersion());
    return;
  }

  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    await initAndServe(parseInitOptions(argv.slice(1)));
    return;
  }

  if (command === "configure") {
    await configureAgents(parseInitOptions(argv.slice(1)));
    return;
  }

  if (command === "config") {
    const diagnostics = await collectConfigDiagnostics(paths);
    console.log(argv.includes("--json") ? JSON.stringify(diagnostics, null, 2) : formatConfigDiagnostics(diagnostics));
    return;
  }

  if (command === "serve") {
    await serveStdio(paths);
    return;
  }

  if (command === "index-all") {
    const bitrix = parseBitrixOptions(argv);
    if (bitrix.full) console.error("Warning: full Bitrix indexing may take a long time on large projects.");
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const startedAt = Date.now();
    const result = await indexAll(paths, { force, reporter, noBitrix: bitrix.noBitrix, bitrixModules: bitrix.modules, includeLang: bitrix.includeLang, includeInstall: bitrix.includeInstall });
    reporter.done({
      scope: "all",
      phase: "done",
      status: "done",
      elapsedMs: Date.now() - startedAt,
      indexedFiles: result.projectFiles + result.templateFiles + result.bitrixFiles + result.installFiles,
      docsChunks: result.docChunks
    });
    console.log(formatIndexAllResult(result));
    return;
  }

  if (command === "index-code") {
    const bitrix = parseBitrixOptions(argv);
    if (bitrix.full) console.error("Warning: full Bitrix indexing may take a long time on large projects.");
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const startedAt = Date.now();
    const result = await indexCode(paths, { force, reporter, noBitrix: bitrix.noBitrix, bitrixModules: bitrix.modules, includeLang: bitrix.includeLang, includeInstall: bitrix.includeInstall });
    reporter.done({
      scope: "code",
      phase: "done",
      status: "done",
      elapsedMs: Date.now() - startedAt,
      indexedFiles: result.projectFiles + result.templateFiles + result.bitrixFiles + result.installFiles
    });
    console.log(formatIndexAllResult({ ...result, docChunks: 0 }));
    return;
  }

  if (command === "index-project") {
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const manifest = await buildIndex({ root: arg ?? paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project"), force, reporter, includeLang: parseBitrixOptions(argv).includeLang });
    console.log(`Indexed ${manifest.files.length} project files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-template") {
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const options = resolveTemplateIndexOptions(paths, arg);
    const manifest = await buildIndex({ ...options, force, reporter, includeLang: parseBitrixOptions(argv).includeLang });
    console.log(`Indexed ${manifest.files.length} template files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-bitrix") {
    const root = arg ?? paths.bitrixRoot;
    if (!root) {
      throw new Error("Bitrix root not found. Run from a project containing ./bitrix, pass [root], or set BITRIX_ROOT.");
    }
    const projectRoot = resolveBitrixProjectRoot(root);
    const bitrix = parseBitrixOptions(argv);
    if (bitrix.full) {
      console.error("Warning: full Bitrix indexing may take a long time on large projects.");
    }
    if (bitrix.modules !== "all") {
      const { found: foundModules, missing } = await validateBitrixModules(projectRoot, bitrix.modules);
      for (const moduleName of missing) {
        console.error(`Warning: Bitrix module "${moduleName}" was requested but not found in ${nodePath.join(projectRoot, "bitrix", "modules", moduleName)}`);
      }
      if (foundModules.length === 0) {
        throw new Error(`None of the requested Bitrix modules were found under ${nodePath.join(projectRoot, "bitrix", "modules")}: ${bitrix.modules.join(", ")}`);
      }
    }
    const resolved = resolveBitrixIndex({ modules: bitrix.modules, includeLang: bitrix.includeLang });
    if (bitrix.plan) {
      await printBitrixPlan(projectRoot, resolved, bitrix.modules);
      return;
    }
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: resolved.patterns, ignores: resolved.ignores, force, reporter, includeLang: bitrix.includeLang });
    console.log(`Indexed ${manifest.files.length} Bitrix files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-install") {
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const manifest = await buildIndex({ ...installIndexOptions(paths, arg), force, reporter, includeLang: parseBitrixOptions(argv).includeLang });
    console.log(`Indexed ${manifest.files.length} install asset files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "docs-add-git") {
    const source = await addGitDocSource(paths.dataDir, arg ?? OFFICIAL_DOCS_GIT_URL);
    console.log(`Registered Git documentation source ${source.uri} at ${source.checkoutPath ?? source.rootPath}`);
    return;
  }

  if (command === "docs-add-path") {
    if (!arg) {
      throw new Error("docs-add-path requires a local documentation directory path.");
    }
    const source = await addPathDocSource(paths.dataDir, arg);
    console.log(`Registered local documentation source ${source.rootPath}`);
    return;
  }

  if (command === "docs-update") {
    const sources = await updateDocSources(paths.dataDir);
    console.log(`Updated ${sources.length} Git documentation source${sources.length === 1 ? "" : "s"}.`);
    return;
  }

  if (command === "index-docs") {
    const reporter = createProgressReporter(parseProgressOptions(argv));
    const startedAt = Date.now();
    reporter.start({ scope: "docs", phase: "docs", status: "start", message: "Index documentation" });
    const chunks = await indexDocResourcesToSqlite(paths.dataDir, paths.docsPaths, { includeOfficialDocs: paths.officialDocsEnabled ?? false, force });
    reporter.done({ scope: "docs", phase: "done", status: "done", elapsedMs: Date.now() - startedAt, docsChunks: chunks });
    console.log(`Indexed ${chunks} documentation chunks into ${sqlitePath(paths.dataDir)}`);
    if (embeddings) {
      console.log(formatIndexEmbeddingsResult(await indexEmbeddings(paths)));
    }
    return;
  }

  if (command === "index-embeddings") {
    console.log(formatIndexEmbeddingsResult(await indexEmbeddings(paths)));
    return;
  }

  if (command === "search-modules") {
    if (!arg) {
      throw new Error("search-modules requires a module name.");
    }
    const results = await searchModuleUsages(sqlitePath(paths.dataDir), { module: arg, limit: 50 }) ?? [];
    console.log(JSON.stringify(formatModuleUsageSearchResults(results), null, 2));
    return;
  }


  if (command === "graph-neighbors") {
    const [, nodeType, nodeName] = positional;
    if (!nodeType || !nodeName) {
      throw new Error("graph-neighbors requires <type> <name>.");
    }
    const result = await getGraphNeighbors(sqlitePath(paths.dataDir), { type: nodeType, name: nodeName }, parseGraphNeighborsOptions(argv.slice(1)));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "impact-radius") {
    const files = positional.slice(1);
    const result = await getImpactRadiusForPaths(paths, parseImpactRadiusOptions(argv.slice(1), files));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    console.log(formatIndexStatus(await readIndexStatus(paths)));
    return;
  }

  if (command === "detect-changes") {
    const result = await detectChanges(paths, parseDetectChangesOptions(argv.slice(1)));
    console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatDetectChangesText(result));
    return;
  }

  if (command === "benchmark") {
    const report = await runBenchmark({ force });
    console.log(`Benchmark report written to ${paths.dataDir}/benchmark.json and ${paths.dataDir}/benchmark.md`);
    console.log(JSON.stringify({ metrics: report.metrics, warnings: report.warnings }, null, 2));
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor(paths);
    if (argv.includes("--json")) {
      const diagnostics = await collectConfigDiagnostics(paths);
      console.log(JSON.stringify({ ...diagnostics, checks }, null, 2));
    } else if (argv.includes("--verbose")) {
      console.log(`${formatDoctor(checks)}\n\n${formatConfigDiagnostics(await collectConfigDiagnostics(paths))}`);
    } else {
      console.log(formatDoctor(checks));
    }
    if (hasDoctorErrors(checks)) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
