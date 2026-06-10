import test from "node:test";
import assert from "node:assert/strict";
import {
  createProgressReporter,
  NoopProgressReporter,
  TtyProgressReporter,
  CompactProgressReporter,
  JsonProgressReporter,
  formatDuration
} from "../src/progress/index.js";

interface FakeStream {
  chunks: string[];
  write(chunk: string): boolean;
  text(): string;
  isTTY: boolean;
  columns: number;
}

function makeStream(isTTY = false): FakeStream {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join("");
    },
    isTTY,
    columns: 80
  };
}

function clock(start = 0) {
  let value = start;
  const now = () => value;
  const advance = (ms: number) => {
    value += ms;
  };
  return { now, advance };
}

test("formatDuration renders mm:ss and hh:mm:ss", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(7_000), "00:07");
  assert.equal(formatDuration(63_000), "01:03");
  assert.equal(formatDuration(3_723_000), "01:02:03");
});

test("createProgressReporter returns TtyProgressReporter for interactive TTY by default", () => {
  const reporter = createProgressReporter({ stderr: makeStream(true) as never, isTty: true });
  assert.ok(reporter instanceof TtyProgressReporter);
});

test("createProgressReporter returns CompactProgressReporter for --compact", () => {
  const reporter = createProgressReporter({ compact: true, stderr: makeStream(true) as never, isTty: true });
  assert.ok(reporter instanceof CompactProgressReporter);
});

test("createProgressReporter returns NoopProgressReporter for --no-progress", () => {
  const reporter = createProgressReporter({ progress: false, stderr: makeStream(true) as never, isTty: true });
  assert.ok(reporter instanceof NoopProgressReporter);
});

test("createProgressReporter returns JsonProgressReporter for --json-progress", () => {
  const reporter = createProgressReporter({ jsonProgress: true, stderr: makeStream(true) as never, isTty: true });
  assert.ok(reporter instanceof JsonProgressReporter);
});

test("createProgressReporter returns NoopProgressReporter for non-TTY by default", () => {
  const reporter = createProgressReporter({ stderr: makeStream(false) as never, isTty: false });
  assert.ok(reporter instanceof NoopProgressReporter);
});

test("createProgressReporter returns NoopProgressReporter under CI by default", () => {
  const reporter = createProgressReporter({ stderr: makeStream(true) as never, isTty: true, isCi: true });
  assert.ok(reporter instanceof NoopProgressReporter);
});

test("createProgressReporter honours forced --progress on non-TTY", () => {
  const reporter = createProgressReporter({ progress: true, stderr: makeStream(false) as never, isTty: false });
  assert.ok(reporter instanceof TtyProgressReporter);
});

test("NoopProgressReporter writes nothing", () => {
  const stream = makeStream();
  const reporter = new NoopProgressReporter();
  reporter.start({ scope: "bitrix", phase: "discover", status: "start" });
  reporter.update({ scope: "bitrix", phase: "parse", current: 1, total: 10 });
  reporter.warn("careful");
  reporter.error("boom");
  reporter.done({ scope: "bitrix", phase: "done", elapsedMs: 1000 });
  assert.equal(stream.text(), "");
});

test("JsonProgressReporter emits one JSON line per lifecycle event", () => {
  const stream = makeStream();
  const reporter = new JsonProgressReporter({ stream });
  reporter.start({ scope: "bitrix", phase: "discover", status: "start" });
  reporter.done({ scope: "bitrix", phase: "discover", status: "done", foundFiles: 100, ignoredFiles: 20, queuedFiles: 80 });

  const lines = stream.text().trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.scope, "bitrix");
  assert.equal(first.phase, "discover");
  assert.equal(first.status, "start");
  const second = JSON.parse(lines[1]);
  assert.equal(second.queuedFiles, 80);
});

test("JsonProgressReporter omits undefined fields", () => {
  const stream = makeStream();
  const reporter = new JsonProgressReporter({ stream });
  reporter.start({ scope: "docs", phase: "docs", status: "start" });
  const parsed = JSON.parse(stream.text().trim());
  assert.ok(!("file" in parsed));
  assert.ok(!("symbols" in parsed));
});

test("CompactProgressReporter writes a dot on progress and a check on phase completion", () => {
  const stream = makeStream();
  const { now } = clock();
  const reporter = new CompactProgressReporter({ stream, now, useUnicode: true });
  reporter.start({ scope: "bitrix", phase: "discover", status: "start" });
  reporter.update({ scope: "bitrix", phase: "parse", current: 1, total: 10 });
  reporter.done({ scope: "bitrix", phase: "parse", status: "done" });

  const text = stream.text();
  assert.ok(text.includes("."), `expected a dot, got: ${JSON.stringify(text)}`);
  assert.ok(text.includes("✓"), `expected a check, got: ${JSON.stringify(text)}`);
});

test("CompactProgressReporter throttles dots within the interval", () => {
  const stream = makeStream();
  const c = clock();
  const reporter = new CompactProgressReporter({ stream, now: c.now, intervalMs: 500, useUnicode: true });
  reporter.start({ scope: "bitrix", phase: "parse", status: "start" });
  reporter.update({ scope: "bitrix", phase: "parse", current: 1, total: 100 });
  reporter.update({ scope: "bitrix", phase: "parse", current: 2, total: 100 });
  reporter.update({ scope: "bitrix", phase: "parse", current: 3, total: 100 });
  const oneDot = (stream.text().match(/\./g) ?? []).length;
  assert.equal(oneDot, 1);

  c.advance(600);
  reporter.update({ scope: "bitrix", phase: "parse", current: 4, total: 100 });
  const twoDots = (stream.text().match(/\./g) ?? []).length;
  assert.equal(twoDots, 2);
});

test("CompactProgressReporter falls back to ASCII without unicode", () => {
  const stream = makeStream();
  const reporter = new CompactProgressReporter({ stream, useUnicode: false });
  reporter.start({ scope: "bitrix", phase: "parse", status: "start" });
  reporter.error("kaboom", { scope: "bitrix", phase: "parse" });
  const text = stream.text();
  assert.ok(!text.includes("✗"), `should not contain unicode cross: ${JSON.stringify(text)}`);
  assert.ok(text.toLowerCase().includes("x") || text.toLowerCase().includes("fail"));
});

test("CompactProgressReporter prints a final summary on scope done", () => {
  const stream = makeStream();
  const reporter = new CompactProgressReporter({ stream, useUnicode: true });
  reporter.start({ scope: "bitrix", phase: "discover", status: "start" });
  reporter.done({
    scope: "bitrix",
    phase: "done",
    status: "done",
    elapsedMs: 463_000,
    indexedFiles: 16_811,
    skippedFiles: 0,
    symbols: 38_210,
    relations: 4_712
  });
  const text = stream.text();
  assert.ok(text.includes("bitrix"));
  assert.ok(text.includes("07:43"), `expected duration, got ${JSON.stringify(text)}`);
  assert.ok(/16[\s ,]?811/.test(text), `expected file count, got ${JSON.stringify(text)}`);
});

test("TtyProgressReporter shows phase, counts and summary", () => {
  const stream = makeStream(true);
  const reporter = new TtyProgressReporter({ stream, isTty: true, now: clock().now, useColor: false });
  reporter.start({ scope: "bitrix", phase: "parse", status: "start", message: "Parse PHP files" });
  reporter.update({ scope: "bitrix", phase: "parse", current: 7, total: 10, file: "bitrix/modules/main/lib/user.php" });
  reporter.done({ scope: "bitrix", phase: "done", status: "done", elapsedMs: 463_000, indexedFiles: 10 });

  const text = stream.text();
  assert.ok(/parse/i.test(text), `expected phase label, got ${JSON.stringify(text)}`);
  assert.ok(text.includes("7") && text.includes("10"), "expected current/total");
  assert.ok(text.includes("07:43"), "expected summary duration");
});

test("TtyProgressReporter throttles intra-phase updates", () => {
  const stream = makeStream(true);
  const c = clock();
  const reporter = new TtyProgressReporter({ stream, isTty: true, now: c.now, intervalMs: 100, useColor: false });
  reporter.start({ scope: "bitrix", phase: "parse", status: "start" });
  const baseline = stream.chunks.length;
  reporter.update({ scope: "bitrix", phase: "parse", current: 1, total: 100 });
  reporter.update({ scope: "bitrix", phase: "parse", current: 2, total: 100 });
  reporter.update({ scope: "bitrix", phase: "parse", current: 3, total: 100 });
  assert.equal(stream.chunks.length - baseline, 1, "throttled to a single render");
});
