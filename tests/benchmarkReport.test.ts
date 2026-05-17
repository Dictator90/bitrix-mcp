import test from "node:test";
import assert from "node:assert/strict";
import { formatBenchmarkMarkdown, type BenchmarkReport } from "../src/benchmark/report.js";

test("formatBenchmarkMarkdown renders timings, counters, and warnings", () => {
  const report: BenchmarkReport = {
    generatedAt: "2026-05-16T00:00:00.000Z",
    workspaceRoot: "/workspace/project",
    dbFile: "/workspace/project/.bitrix-mcp/bitrix-mcp.sqlite",
    force: false,
    steps: [
      { name: "index-all", status: "ok", elapsedMs: 12.34 },
      { name: "index-bitrix", status: "skipped", warning: "Bitrix root was not detected." }
    ],
    metrics: {
      dbSizeBytes: 4096,
      indexedFiles: 10,
      symbols: 20,
      events: 2,
      relations: 5,
      docsChunks: 7
    },
    warnings: ["index-bitrix: Bitrix root was not detected."]
  };

  const markdown = formatBenchmarkMarkdown(report);

  assert.match(markdown, /# Bitrix MCP Benchmark Report/u);
  assert.match(markdown, /\| index-all \| ok \| 12\.3 ms \|/u);
  assert.match(markdown, /\| index-bitrix \| skipped \| skipped — Bitrix root was not detected\. \|/u);
  assert.match(markdown, /\| SQLite DB size \| 4096 bytes \|/u);
  assert.match(markdown, /- index-bitrix: Bitrix root was not detected\./u);
});
