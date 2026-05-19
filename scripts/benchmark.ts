import { runBenchmark, type BenchmarkOptions } from "../src/benchmark/report.js";

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--output-dir") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--output-dir requires a directory.");
      options.outputDir = next;
      index += 1;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run benchmark -- [--force] [--output-dir .bitrix-mcp]");
      process.exit(0);
    }
  }
  return options;
}

const report = await runBenchmark(parseArgs(process.argv.slice(2)));
console.log(`Benchmark report written to ${report.dbFile.replace(/bitrix-mcp\.sqlite$/u, "benchmark.json")} and benchmark.md`);
console.log(JSON.stringify({ metrics: report.metrics, warnings: report.warnings }, null, 2));
