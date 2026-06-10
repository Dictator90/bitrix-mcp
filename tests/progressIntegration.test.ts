import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer/indexer.js";
import { indexPath } from "../src/config/paths.js";
import type { IndexProgressEvent, ProgressReporter } from "../src/progress/index.js";

class RecordingReporter implements ProgressReporter {
  readonly calls: Array<{ method: string; event: IndexProgressEvent }> = [];
  start(event: IndexProgressEvent): void {
    this.calls.push({ method: "start", event });
  }
  update(event: IndexProgressEvent): void {
    this.calls.push({ method: "update", event });
  }
  warn(): void {}
  error(): void {}
  done(event: IndexProgressEvent): void {
    this.calls.push({ method: "done", event });
  }
}

const fixtureRoot = path.resolve("tests/fixtures/project");

test("buildIndex emits discover, parse and done progress events", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-progress-"));
  const reporter = new RecordingReporter();

  await buildIndex({
    root: fixtureRoot,
    kind: "project",
    outFile: indexPath(dataDir, "project"),
    reporter,
    force: true
  });

  const phases = reporter.calls.map((call) => `${call.method}:${call.event.phase}`);
  assert.ok(phases.includes("start:discover"), `missing discover start: ${phases.join(", ")}`);
  assert.ok(phases.includes("done:discover"), `missing discover done: ${phases.join(", ")}`);
  assert.ok(phases.includes("start:parse"), `missing parse start: ${phases.join(", ")}`);
  assert.ok(reporter.calls.some((call) => call.method === "update" && call.event.phase === "parse"), "missing parse updates");

  const discoverDone = reporter.calls.find((call) => call.method === "done" && call.event.phase === "discover");
  assert.ok(discoverDone);
  assert.ok((discoverDone!.event.queuedFiles ?? 0) > 0, "expected queued files");

  const finalDone = reporter.calls.find((call) => call.method === "done" && call.event.phase === "done");
  assert.ok(finalDone, "missing final done");
  assert.equal(finalDone!.event.scope, "project");
  assert.ok((finalDone!.event.indexedFiles ?? 0) > 0, "expected indexed files in summary");
  assert.ok(finalDone!.event.elapsedMs !== undefined, "expected elapsedMs in summary");
});

test("buildIndex carries every parse update file within the queued total", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-progress-files-"));
  const reporter = new RecordingReporter();

  await buildIndex({
    root: fixtureRoot,
    kind: "project",
    outFile: indexPath(dataDir, "project"),
    reporter,
    force: true
  });

  const updates = reporter.calls.filter((call) => call.method === "update" && call.event.phase === "parse");
  for (const update of updates) {
    assert.ok(update.event.current !== undefined && update.event.total !== undefined);
    assert.ok(update.event.current! <= update.event.total!);
    assert.ok(typeof update.event.file === "string" && update.event.file.length > 0);
  }
});
