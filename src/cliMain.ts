import nodePath from "node:path";
import { readPackageVersion } from "./config/version.js";
import { collectConfigDiagnostics, formatConfigDiagnostics } from "./config/diagnostics.js";
import { indexPath, resolveBitrixProjectRoot, resolveRuntimePaths, sqlitePath } from "./config/paths.js";
import { detectChanges, formatDetectChangesText, type DetectChangesOptions } from "./indexer/detectChanges.js";
import { getGraphNeighbors, getImpactRadiusForPaths, type GraphNeighborsOptions, type ImpactRadiusOptions } from "./indexer/graph.js";
import { buildIndex, discoverFiles, relativeBaseFor } from "./indexer/indexer.js";
import { resolveBitrixIndex, parseModuleSelection, validateBitrixModules, detectBitrixModule, type BitrixModuleSelection } from "./indexer/bitrixModules.js";
import { searchModuleUsages } from "./indexer/sqliteStore.js";
import { formatDoctor, formatIndexAllResult, formatIndexEmbeddingsResult, formatIndexStatus, hasDoctorErrors, indexAll, indexCode, indexEmbeddings, installIndexOptions, readIndexStatus, runDoctor } from "./indexer/actions.js";
import { resolveTemplateIndexOptions } from "./indexer/template.js";
import { AGENT_CHOICES, configureAgents, initAndServe, parseAgentIds, type Agent, type InitOptions } from "./init/init.js";
import { runUninstall } from "./init/uninstall.js";
import { commandHelp, flag, integerOption, listOption, parseCli, stringOption, UsageError, type OptionValues } from "./cli/args.js";
import { addGitDocSource, addPathDocSource, indexDocResourcesToSqlite, OFFICIAL_DOCS_GIT_URL, updateDocSources } from "./resources/docs.js";
import { serveStdio } from "./mcp/server.js";
import { runBenchmark } from "./benchmark/report.js";
import { formatModuleUsageSearchResults } from "./mcp/format.js";
import { createProgressReporter, detectCi, type CreateProgressReporterOptions } from "./progress/index.js";

function usage(): string {
  return `Usage: bitrix-mcp <command> [options]

Global options:
  --version, -v                 Print the installed bitrix-mcp version and exit
  --help, -h                    Show this help and exit (bitrix-mcp <command> --help for one command)
  --debug                       Print the stack trace when a command fails

Commands:
  init [options]                Configure MCP clients and index the project/docs (the MCP client starts the server; use --serve to start it now)
  configure [options]           Configure MCP clients and guidance only (no indexing or server)
  uninstall [--agent <id>] [--all-agents] [--dry-run]
                                Remove MCP config entries, hooks, guidance sections, and skills written by init/configure
  config [--json]               Show resolved runtime paths and MCP client config file presence
  serve                         Start MCP server over stdio
  index-all [--force]           Index project, templates, Bitrix modules, and docs (add --install for install assets)
  index-code [--force]          Index project, templates, and Bitrix modules (add --install for install assets)
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
  --no-db                       Disable project DB access (read is enabled by default)
  --db-allow-write              Allow DB writes (INSERT/UPDATE/DELETE) in addition to read access
  --tinker                      Enable bitrix_tinker (arbitrary PHP execution with the Bitrix kernel) in the generated config, default off
  --php-bin <path>              PHP CLI binary for bitrix_tinker (auto-detected when omitted; Herd/Laragon/XAMPP/OpenServer/PATH)
  --no-hooks                    Do not write agent context-injection hooks (Claude Code, Cursor, Gemini, Codex, Copilot, Cline)
  --yes, -y                     Accept defaults for non-interactive init/configure (configures Cursor unless --agent is given)

Uninstall options:
  --agent <id> / --all-agents   Limit removal to these agents (default: all agents)
  --dry-run                     Print what would change without changing anything

Value options accept both "--name value" and "--name=value". Unknown options are an error (exit code 2).

Agent IDs: cursor, claude-code, jetbrains, vscode, windsurf, cline, roo-code, continue, gemini-cli, codex, kilo-code, generic-json

Environment:
  BITRIX_MCP_DATA_DIR           Directory for generated indexes
  BITRIX_MCP_DOCS_PATHS         Documentation directories separated by the platform path delimiter
  BITRIX_MCP_DOCS_DIR           Legacy directory with local Bitrix documentation
  BITRIX_MCP_EMBEDDINGS_URL     Python embeddings service URL
  BITRIX_MCP_SEMANTIC_ENABLED   Enable optional semantic MCP tool (1/true/yes/on)
  BITRIX_MCP_OFFICIAL_DOCS_ENABLED Auto-register/update official Bitrix docs during docs indexing (default on)
  BITRIX_ROOT                   Bitrix project root for LiveAPI indexing
  BITRIX_MCP_HOME_DIR           Override the home directory used for global client configs (Windsurf, Cline, Codex, Kilo Code)
`;
}

function parseInitOptions(values: OptionValues): InitOptions {
  const options: InitOptions = {};
  if (flag(values, "all-agents")) options.allAgents = true;
  if (flag(values, "no-index")) options.index = false;
  if (flag(values, "no-docs")) options.docs = false;
  if (flag(values, "no-official-docs")) options.officialDocs = false;
  if (flag(values, "no-serve")) options.serve = false;
  if (flag(values, "serve")) options.serve = true;
  if (flag(values, "no-db")) options.db = false;
  if (flag(values, "db-allow-write")) options.dbAllowWrite = true;
  if (flag(values, "tinker")) options.tinker = true;
  if (flag(values, "yes")) options.yes = true;
  if (flag(values, "no-hooks")) options.hooks = false;
  const phpBin = stringOption(values, "php-bin");
  if (phpBin !== undefined) options.phpBin = phpBin;

  const agents = parseAgentOption(values);
  if (agents) options.agents = agents;
  return options;
}

function parseAgentOption(values: OptionValues): Agent[] | undefined {
  const agentValues = listOption(values, "agent");
  if (agentValues.length === 0) {
    return undefined;
  }
  const agents = parseAgentIds(agentValues);
  const unknown = agentValues.filter((value) => parseAgentIds([value]).length === 0);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown agent id for --agent: ${unknown.join(", ")}. Known ids: ${AGENT_CHOICES.map((choice) => choice.id).join(", ")}`);
  }
  return agents;
}

function parseDirection(values: OptionValues): GraphNeighborsOptions["direction"] {
  const direction = stringOption(values, "direction");
  if (direction === undefined) return undefined;
  if (direction !== "out" && direction !== "in" && direction !== "both") {
    throw new UsageError("--direction must be out, in, or both.");
  }
  return direction;
}

function formatOption(values: OptionValues): { format?: "full" } {
  return flag(values, "full") ? { format: "full" } : {};
}

function parseDetectChangesOptions(values: OptionValues): DetectChangesOptions {
  const options: DetectChangesOptions = { ...formatOption(values) };
  const base = stringOption(values, "base");
  if (base !== undefined) options.base = base;
  if (values.kind !== undefined) options.kind = listOption(values, "kind");
  if (flag(values, "include-source")) options.includeSource = true;
  if (flag(values, "no-relations")) options.includeRelations = false;
  if (flag(values, "no-impact")) options.includeImpact = false;
  if (flag(values, "no-risk")) options.includeRisk = false;
  if (flag(values, "no-symbol-diff")) options.symbolDiff = false;
  const diffBaseline = stringOption(values, "diff-baseline");
  if (diffBaseline !== undefined) {
    if (diffBaseline !== "auto" && diffBaseline !== "index" && diffBaseline !== "git") throw new Error("--diff-baseline must be auto, index, or git.");
    options.diffBaseline = diffBaseline;
  }
  const maxDepth = integerOption(values, "depth", 0);
  if (maxDepth !== undefined) options.maxDepth = maxDepth;
  const maxFiles = integerOption(values, "max-files", 1);
  if (maxFiles !== undefined) options.maxFiles = maxFiles;
  const maxItems = integerOption(values, "max-items", 1);
  if (maxItems !== undefined) options.maxItems = maxItems;
  return options;
}

function parseGraphNeighborsOptions(values: OptionValues): GraphNeighborsOptions {
  const options: GraphNeighborsOptions = { ...formatOption(values) };
  const direction = parseDirection(values);
  if (direction) options.direction = direction;
  const relationType = stringOption(values, "relation-type");
  if (relationType !== undefined) options.relationType = relationType;
  const depth = integerOption(values, "depth", 0);
  if (depth !== undefined) options.depth = depth;
  const limit = integerOption(values, "limit", 1);
  if (limit !== undefined) options.limit = limit;
  return options;
}

function parseImpactRadiusOptions(values: OptionValues, files: string[]): ImpactRadiusOptions {
  const options: ImpactRadiusOptions = { files: files.length > 0 ? files : undefined, ...formatOption(values) };
  const base = stringOption(values, "base");
  if (base !== undefined) options.base = base;
  const maxDepth = integerOption(values, "depth", 0);
  if (maxDepth !== undefined) options.maxDepth = maxDepth;
  if (values["relation-types"] !== undefined) options.relationTypes = listOption(values, "relation-types");
  if (flag(values, "no-symbols")) options.includeChangedSymbols = false;
  if (flag(values, "no-risk")) options.includeRisk = false;
  const limit = integerOption(values, "limit", 1);
  if (limit !== undefined) options.limit = limit;
  return options;
}

function parseProgressOptions(values: OptionValues): CreateProgressReporterOptions {
  const options: CreateProgressReporterOptions = {
    stderr: process.stderr,
    isTty: Boolean(process.stderr.isTTY),
    isCi: detectCi()
  };
  if (flag(values, "no-progress")) {
    options.progress = false;
  } else if (flag(values, "progress")) {
    options.progress = true;
  }
  if (flag(values, "compact")) {
    options.compact = true;
  }
  if (flag(values, "json-progress")) {
    options.jsonProgress = true;
  }
  return options;
}

interface BitrixCliOptions {
  modules: BitrixModuleSelection;
  includeLang: boolean;
  includeInstall: boolean;
  full: boolean;
  plan: boolean;
  noBitrix: boolean;
}

function parseBitrixOptions(values: OptionValues): BitrixCliOptions {
  const full = flag(values, "full");
  const plan = flag(values, "plan");
  const noBitrix = flag(values, "no-bitrix");
  let includeLang = flag(values, "include-lang");
  if (flag(values, "exclude-lang")) {
    includeLang = false;
  }
  let includeInstall = flag(values, "install");
  let modules: BitrixModuleSelection = parseModuleSelection(stringOption(values, "modules") ?? stringOption(values, "bitrix-modules")) ?? "all";
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

async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.kind === "version") {
    console.log(readPackageVersion());
    return;
  }
  if (parsed.kind === "usage") {
    console.log(usage());
    return;
  }
  if (parsed.kind === "help") {
    console.log(commandHelp(parsed.command));
    return;
  }

  const { command, values, positionals } = parsed;
  const [arg] = positionals;
  const force = flag(values, "force");
  const embeddings = flag(values, "embeddings");
  const paths = resolveRuntimePaths();

  if (command === "init") {
    await initAndServe(parseInitOptions(values));
    return;
  }

  if (command === "configure") {
    await configureAgents(parseInitOptions(values));
    return;
  }

  if (command === "uninstall") {
    await runUninstall({ agents: parseAgentOption(values), allAgents: flag(values, "all-agents"), dryRun: flag(values, "dry-run") });
    return;
  }

  if (command === "config") {
    const diagnostics = await collectConfigDiagnostics(paths);
    console.log(flag(values, "json") ? JSON.stringify(diagnostics, null, 2) : formatConfigDiagnostics(diagnostics));
    return;
  }

  if (command === "serve") {
    await serveStdio(paths);
    return;
  }

  if (command === "index-all") {
    const bitrix = parseBitrixOptions(values);
    if (bitrix.full) console.error("Warning: full Bitrix indexing may take a long time on large projects.");
    const reporter = createProgressReporter(parseProgressOptions(values));
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
    const bitrix = parseBitrixOptions(values);
    if (bitrix.full) console.error("Warning: full Bitrix indexing may take a long time on large projects.");
    const reporter = createProgressReporter(parseProgressOptions(values));
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
    const reporter = createProgressReporter(parseProgressOptions(values));
    const projectRoot = nodePath.resolve(arg ?? paths.workspaceRoot);
    const manifest = await buildIndex({ root: projectRoot, relativeTo: relativeBaseFor(paths.workspaceRoot, projectRoot), kind: "project", outFile: indexPath(paths.dataDir, "project"), force, reporter, includeLang: parseBitrixOptions(values).includeLang, retainSymbols: false });
    console.log(`Indexed ${manifest.files.length} project files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-template") {
    const reporter = createProgressReporter(parseProgressOptions(values));
    const options = resolveTemplateIndexOptions(paths, arg);
    const manifest = await buildIndex({ ...options, force, reporter, includeLang: parseBitrixOptions(values).includeLang, retainSymbols: false });
    console.log(`Indexed ${manifest.files.length} template files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-bitrix") {
    const root = arg ?? paths.bitrixRoot;
    if (!root) {
      throw new Error("Bitrix root not found. Run from a project containing ./bitrix, pass [root], or set BITRIX_ROOT.");
    }
    const projectRoot = resolveBitrixProjectRoot(root);
    const bitrix = parseBitrixOptions(values);
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
    const reporter = createProgressReporter(parseProgressOptions(values));
    const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: resolved.patterns, ignores: resolved.ignores, force, reporter, includeLang: bitrix.includeLang, retainSymbols: false });
    console.log(`Indexed ${manifest.files.length} Bitrix files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-install") {
    const reporter = createProgressReporter(parseProgressOptions(values));
    const manifest = await buildIndex({ ...installIndexOptions(paths, arg), force, reporter, includeLang: parseBitrixOptions(values).includeLang, retainSymbols: false });
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
    const reporter = createProgressReporter(parseProgressOptions(values));
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
    const [nodeType, nodeName] = positionals;
    if (!nodeType || !nodeName) {
      throw new Error("graph-neighbors requires <type> <name>.");
    }
    const result = await getGraphNeighbors(sqlitePath(paths.dataDir), { type: nodeType, name: nodeName }, parseGraphNeighborsOptions(values));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "impact-radius") {
    const result = await getImpactRadiusForPaths(paths, parseImpactRadiusOptions(values, positionals));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    console.log(formatIndexStatus(await readIndexStatus(paths)));
    return;
  }

  if (command === "detect-changes") {
    const result = await detectChanges(paths, parseDetectChangesOptions(values));
    console.log(flag(values, "json") ? JSON.stringify(result, null, 2) : formatDetectChangesText(result));
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
    if (flag(values, "json")) {
      const diagnostics = await collectConfigDiagnostics(paths);
      console.log(JSON.stringify({ ...diagnostics, checks }, null, 2));
    } else if (flag(values, "verbose")) {
      console.log(`${formatDoctor(checks)}\n\n${formatConfigDiagnostics(await collectConfigDiagnostics(paths))}`);
    } else {
      console.log(formatDoctor(checks));
    }
    if (hasDoctorErrors(checks)) {
      process.exitCode = 1;
    }
    return;
  }

  throw new UsageError(`Unknown command: ${command}`);
}

const cliArgv = process.argv.slice(2);
main(cliArgv).catch((error) => {
  const debug = cliArgv.includes("--debug");
  if (error instanceof Error) {
    console.error(debug && error.stack ? error.stack : `Error: ${error.message}`);
  } else {
    console.error(`Error: ${String(error)}`);
  }
  if (error instanceof UsageError) {
    if (!error.message.includes("--help")) {
      console.error("Run \"bitrix-mcp --help\" for usage.");
    }
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
});
