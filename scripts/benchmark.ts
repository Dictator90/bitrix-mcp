import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { indexAll } from "../src/indexer/actions.js";
import { searchLiveApi, searchSqliteDocs, searchSqliteEvents } from "../src/liveapi/search.js";
import { addPathDocSource } from "../src/resources/docs.js";

interface BenchmarkOptions {
  files: number;
  docs: number;
  keep: boolean;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { files: 5_000, docs: 500, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--files") {
      options.files = Number(argv[++index] ?? options.files);
    } else if (arg.startsWith("--files=")) {
      options.files = Number(arg.slice("--files=".length));
    } else if (arg === "--docs") {
      options.docs = Number(argv[++index] ?? options.docs);
    } else if (arg.startsWith("--docs=")) {
      options.docs = Number(arg.slice("--docs=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run benchmark -- [--files 5000] [--docs 500] [--keep]");
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.files) || options.files < 1) throw new Error("--files must be a positive integer");
  if (!Number.isInteger(options.docs) || options.docs < 0) throw new Error("--docs must be a non-negative integer");
  return options;
}

async function writeFixture(root: string, options: BenchmarkOptions): Promise<void> {
  const localDir = path.join(root, "local", "modules", "vendor.bench", "lib");
  const docsDir = path.join(root, "docs");
  await fs.mkdir(localDir, { recursive: true });
  await fs.mkdir(docsDir, { recursive: true });

  const writes: Promise<void>[] = [];
  for (let index = 0; index < options.files; index += 1) {
    const module = `bench${index % 20}`;
    const className = `BenchClass${index}`;
    const fnName = `bench_function_${index}`;
    const eventName = `OnBenchEvent${index % 100}`;
    writes.push(fs.writeFile(path.join(localDir, `bench-${index}.php`), `<?php
namespace Vendor\\Bench;

class ${className}
{
    public function handle${index}(): string
    {
        return '${fnName}';
    }
}

function ${fnName}(): void {}
\\Bitrix\\Main\\EventManager::getInstance()->addEventHandler('${module}', '${eventName}', [${className}::class, 'handle${index}']);
`, "utf8"));
  }

  for (let index = 0; index < options.docs; index += 1) {
    writes.push(fs.writeFile(path.join(docsDir, `doc-${index}.md`), `# Managed cache benchmark ${index}

This fixture mentions managed cache, iblock, agents, modules, and synthetic Bitrix APIs.
Document number ${index} repeats searchable content for FTS timing.
`, "utf8"));
  }

  await Promise.all(writes);
}

async function time<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await action();
  const elapsed = performance.now() - started;
  console.log(`${label}: ${elapsed.toFixed(1)}ms`);
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-bench-"));
  const dataDir = path.join(root, ".bitrix-mcp");
  const docsDir = path.join(root, "docs");
  const paths: RuntimePaths = {
    workspaceRoot: root,
    bitrixRoot: root,
    dataDir,
    docsDir,
    docsPaths: [docsDir],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    officialDocsEnabled: false
  };

  try {
    await time(`Generate fixture (${options.files} code files, ${options.docs} docs)`, () => writeFixture(root, options));
    await addPathDocSource(dataDir, docsDir, "benchmark-docs");
    const indexResult = await time("Index all", () => indexAll(paths, { force: true }));
    console.log(JSON.stringify(indexResult, null, 2));

    const dbFile = sqlitePath(dataDir);
    const symbolResults = await time("Search symbols", () => searchLiveApi(dbFile, { query: "bench_function_42", limit: 20 }));
    const eventResults = await time("Search events", () => searchSqliteEvents(dbFile, { query: "OnBenchEvent42", module: "bench2", limit: 20 }));
    const docResults = await time("Search docs", () => searchSqliteDocs(dbFile, { query: "managed cache", limit: 10 }));

    console.log(JSON.stringify({
      symbolResults: symbolResults?.length ?? 0,
      eventResults: eventResults?.length ?? 0,
      docResults: docResults?.length ?? 0,
      dbFile
    }, null, 2));
  } finally {
    if (options.keep) {
      console.log(`Fixture kept at ${root}`);
    } else {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
