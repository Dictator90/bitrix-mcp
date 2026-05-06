#!/usr/bin/env node
import { indexPath, resolveBitrixProjectRoot, resolveRuntimePaths } from "./config/paths.js";
import { buildIndex } from "./indexer/indexer.js";
import { resolveTemplateIndexOptions } from "./indexer/template.js";
import { initAndServe } from "./init/init.js";
import { serveStdio } from "./mcp/server.js";

function usage(): string {
  return `Usage: bitrix-mcp <command> [options]

Commands:
  init                          Configure an MCP client, index the project, and start stdio server
  serve                         Start MCP server over stdio
  index-project [root]          Index project files
  index-template [templatePath] Index a specific template path, or standard template locations
  index-bitrix [root]            Index installed Bitrix Framework PHP sources

Environment:
  BITRIX_MCP_DATA_DIR           Directory for generated indexes
  BITRIX_MCP_DOCS_DIR           Directory with local Bitrix documentation
  BITRIX_MCP_EMBEDDINGS_URL     Python embeddings service URL
  BITRIX_ROOT                   Bitrix project root for LiveAPI indexing
`;
}

async function main(argv: string[]): Promise<void> {
  const [command, arg] = argv;
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

  if (command === "index-project") {
    const manifest = await buildIndex({ root: arg ?? paths.workspaceRoot, kind: "project", outFile: indexPath(paths.dataDir, "project") });
    console.log(`Indexed ${manifest.files.length} project files into ${indexPath(paths.dataDir, "project")}`);
    return;
  }

  if (command === "index-template") {
    const options = resolveTemplateIndexOptions(paths, arg);
    const manifest = await buildIndex(options);
    console.log(`Indexed ${manifest.files.length} template files into ${indexPath(paths.dataDir, "template")}`);
    return;
  }

  if (command === "index-bitrix") {
    const root = arg ?? paths.bitrixRoot;
    if (!root) {
      throw new Error("Bitrix root not found. Run from a project containing ./bitrix, pass [root], or set BITRIX_ROOT.");
    }
    const projectRoot = resolveBitrixProjectRoot(root);
    const manifest = await buildIndex({ root: projectRoot, kind: "bitrix", outFile: indexPath(paths.dataDir, "bitrix"), patterns: ["bitrix/modules/**/*.php", "local/modules/**/*.php"] });
    console.log(`Indexed ${manifest.files.length} Bitrix files into ${indexPath(paths.dataDir, "bitrix")}`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
