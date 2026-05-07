#!/usr/bin/env node
import { indexPath, resolveBitrixProjectRoot, resolveRuntimePaths, sqlitePath } from "./config/paths.js";
import { buildIndex } from "./indexer/indexer.js";
import { formatDoctor, formatIndexAllResult, formatIndexEmbeddingsResult, formatIndexStatus, hasDoctorErrors, indexAll, indexCode, indexEmbeddings, installIndexOptions, readIndexStatus, runDoctor } from "./indexer/actions.js";
import { resolveTemplateIndexOptions } from "./indexer/template.js";
import { initAndServe } from "./init/init.js";
import { addGitDocSource, addPathDocSource, indexDocResourcesToSqlite, OFFICIAL_DOCS_GIT_URL, updateDocSources } from "./resources/docs.js";
import { serveStdio } from "./mcp/server.js";

function usage(): string {
  return `Usage: bitrix-mcp <command> [options]

Commands:
  init                          Configure an MCP client, index the project, and start stdio server
  serve                         Start MCP server over stdio
  index-all [--force]           Index project, templates, Bitrix modules, install assets, and docs
  index-code [--force]          Index project, templates, Bitrix modules, and install assets
  index-project [root] [--force] Index project files
  index-template [templatePath] [--force] Index a specific template path, or standard template locations
  index-bitrix [root] [--force]  Index installed Bitrix Framework PHP sources
  index-install [root] [--force] Index Bitrix module install assets
  docs-add-git [url]            Register a Git documentation source (defaults to official Bitrix docs)
  docs-add-path <path>          Register a local documentation directory
  docs-update                   Clone or pull registered Git documentation sources
  index-docs [--force] [--embeddings] Index registered documentation sources into SQLite, optionally then into embeddings
  index-embeddings              Send SQLite documentation chunks to the embeddings service
  status                        Show SQLite DB path and index counters
  doctor                        Check workspace, Bitrix root, SQLite, docs, ignore file, and embeddings

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

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const embeddings = argv.includes("--embeddings");
  const positional = argv.filter((value) => value !== "--force" && value !== "--embeddings");
  const [command, arg] = positional;
  const paths = resolveRuntimePaths();

  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    await initAndServe();
    return;
  }

  if (command === "serve") {
    await serveStdio(paths);
    return;
  }

  if (command === "index-all") {
    console.log(formatIndexAllResult(await indexAll(paths, { force })));
    return;
  }

  if (command === "index-code") {
    const result = await indexCode(paths, { force });
    console.log(formatIndexAllResult({ ...result, docChunks: 0 }));
    return;
  }

  if (command === "index-project") {
    const manifest = await buildIndex({ root: arg ?? paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project"), force });
    console.log(`Indexed ${manifest.files.length} project files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-template") {
    const options = resolveTemplateIndexOptions(paths, arg);
    const manifest = await buildIndex({ ...options, force });
    console.log(`Indexed ${manifest.files.length} template files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-bitrix") {
    const root = arg ?? paths.bitrixRoot;
    if (!root) {
      throw new Error("Bitrix root not found. Run from a project containing ./bitrix, pass [root], or set BITRIX_ROOT.");
    }
    const projectRoot = resolveBitrixProjectRoot(root);
    const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: ["bitrix/modules/**/*.php", "local/modules/**/*.php"], force });
    console.log(`Indexed ${manifest.files.length} Bitrix files into ${sqlitePath(paths.dataDir)}`);
    return;
  }

  if (command === "index-install") {
    const manifest = await buildIndex({ ...installIndexOptions(paths, arg), force });
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
    const chunks = await indexDocResourcesToSqlite(paths.dataDir, paths.docsPaths, { includeOfficialDocs: paths.officialDocsEnabled ?? false, force });
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

  if (command === "status") {
    console.log(formatIndexStatus(await readIndexStatus(paths)));
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor(paths);
    console.log(formatDoctor(checks));
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
