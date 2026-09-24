import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { AsyncMutex } from "../src/mcp/asyncMutex.js";
import { WorkerPool } from "../src/mcp/workerPool.js";
import { classifyWorkerTask, closeWorkerPools, indexMutex, readPoolStats, runWorkerTask, setTaskWorkerFactory, withMcpToolGuard } from "../src/mcp/toolGuards.js";
import type { WorkerTask } from "../src/mcp/worker.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { RuntimePaths } from "../src/config/paths.js";

const execFileAsync = promisify(execFile);
const fakeWorkerUrl = new URL("./fixtures/workers/fakeTaskWorker.mjs", import.meta.url);
const createFakeWorker = () => new Worker(fakeWorkerUrl);
const paths = { workspaceRoot: ".", dataDir: "." } as RuntimePaths;

function fakePool(size = 1, respawnOnKill = false): WorkerPool {
  return new WorkerPool({ size, respawnOnKill, createWorker: createFakeWorker });
}

test("worker pool reuses a warm worker for consecutive tasks", async () => {
  const pool = fakePool(2);
  try {
    const first = await pool.run<{ value: number; threadId: number }>("t", { name: "echo", value: 1 }, { timeoutMs: 5000 });
    const second = await pool.run<{ value: number; threadId: number }>("t", { name: "echo", value: 2 }, { timeoutMs: 5000 });
    assert.equal(first.value, 1);
    assert.equal(second.value, 2);
    assert.equal(second.threadId, first.threadId);
    assert.deepEqual(pool.stats(), { size: 2, workers: 1, busy: 0, queued: 0, spawned: 1 });
  } finally {
    await pool.close();
  }
});

test("worker pool runs up to size tasks in parallel and queues the rest", async () => {
  const pool = fakePool(2);
  try {
    const runs = [1, 2, 3].map(() => pool.run<{ threadId: number }>("t", { name: "sleep", ms: 150 }, { timeoutMs: 5000 }));
    assert.equal(pool.stats().queued, 1);
    const results = await Promise.all(runs);
    assert.equal(new Set(results.map((result) => result.threadId)).size, 2);
    assert.equal(pool.stats().spawned, 2);
  } finally {
    await pool.close();
  }
});

test("worker pool rejects in-flight tasks immediately when a worker exits and recovers", async () => {
  const pool = fakePool(1);
  try {
    const startedAt = Date.now();
    await assert.rejects(pool.run("bitrix_crash", { name: "exit", code: 0 }, { timeoutMs: 10_000 }), /MCP tool bitrix_crash worker exited unexpectedly with code 0/);
    await assert.rejects(pool.run("bitrix_crash", { name: "exit", code: 3 }, { timeoutMs: 10_000 }), /exited unexpectedly with code 3/);
    await assert.rejects(pool.run("bitrix_crash", { name: "throw" }, { timeoutMs: 10_000 }), /exited unexpectedly with code 1: fake worker crashed/);
    assert.ok(Date.now() - startedAt < 5000, "crashes must not wait for the timeout");
    const result = await pool.run<{ value: string }>("t", { name: "echo", value: "ok" }, { timeoutMs: 5000 });
    assert.equal(result.value, "ok");
    assert.equal(pool.stats().spawned, 4);
  } finally {
    await pool.close();
  }
});

test("worker pool surfaces task errors without replacing the worker", async () => {
  const pool = fakePool(1);
  try {
    await assert.rejects(pool.run("t", { name: "fail" }, { timeoutMs: 5000 }), /task failed on purpose/);
    await pool.run("t", { name: "echo", value: 1 }, { timeoutMs: 5000 });
    assert.equal(pool.stats().spawned, 1);
  } finally {
    await pool.close();
  }
});

test("worker pool timeout terminates a blocked worker and replaces it", async () => {
  const pool = fakePool(1, true);
  try {
    const blocked = await pool.run<{ threadId: number }>("t", { name: "echo", value: 0 }, { timeoutMs: 5000 });
    await assert.rejects(pool.run("bitrix_slow", { name: "block", ms: 3000 }, { timeoutMs: 200 }), /MCP tool bitrix_slow was cancelled after exceeding timeout of 200ms/);
    assert.equal(pool.stats().spawned, 2, "a replacement worker is spawned right away");
    const next = await pool.run<{ threadId: number }>("t", { name: "echo", value: 1 }, { timeoutMs: 5000 });
    assert.notEqual(next.threadId, blocked.threadId);
  } finally {
    await pool.close();
  }
});

test("worker pool abort signal cancels running and queued tasks", async () => {
  const pool = fakePool(1);
  try {
    const controller = new AbortController();
    const running = pool.run("bitrix_running", { name: "block", ms: 3000 }, { timeoutMs: 10_000, signal: controller.signal });
    const queued = pool.run("bitrix_queued", { name: "echo", value: 1 }, { timeoutMs: 10_000, signal: controller.signal });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /MCP tool bitrix_running was cancelled by the client/);
    await assert.rejects(queued, /MCP tool bitrix_queued was cancelled by the client/);
    assert.ok(Date.now() - startedAt < 2000);
    assert.equal(pool.stats().workers, 0);
    await assert.rejects(pool.run("t", { name: "echo" }, { timeoutMs: 5000, signal: controller.signal }), /cancelled by the client/);
  } finally {
    await pool.close();
  }
});

test("idle pool workers do not keep the process alive", async () => {
  const script = [
    `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";`,
    `import { WorkerPool } from ${JSON.stringify(new URL("../src/mcp/workerPool.ts", import.meta.url).href)};`,
    `const pool = new WorkerPool({ size: 2, createWorker: () => new Worker(new URL(${JSON.stringify(fakeWorkerUrl.href)}), { execArgv: [] }) });`,
    `const result = await pool.run("t", { name: "echo", value: "done" }, { timeoutMs: 5000 });`,
    `console.log(result.value);`
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 15_000 });
  assert.equal(stdout.trim(), "done");
});

test("async mutex serializes holders and drops aborted waiters", async () => {
  const mutex = new AsyncMutex();
  const order: string[] = [];
  const release = await mutex.acquire();
  const controller = new AbortController();
  const aborted = mutex.acquire(controller.signal);
  const second = mutex.runExclusive(async () => { order.push("second"); });
  assert.equal(mutex.pending, 2);
  controller.abort(new Error("gone"));
  await assert.rejects(aborted, /gone/);
  assert.equal(mutex.pending, 1);
  order.push("first");
  release();
  await second;
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(mutex.isLocked, false);
});

test("tasks are classified by worker task name", () => {
  assert.equal(classifyWorkerTask("searchLiveApi"), "read");
  assert.equal(classifyWorkerTask("dbQuery"), "read");
  assert.equal(classifyWorkerTask("indexAll"), "index");
  assert.equal(classifyWorkerTask("indexDocs"), "index");
  assert.equal(classifyWorkerTask("tinker"), "heavy");
  assert.equal(classifyWorkerTask("dbExecute"), "heavy");
});

test("runWorkerTask serializes concurrent index tasks and forwards progress", async (t) => {
  await setTaskWorkerFactory(createFakeWorker);
  t.after(() => setTaskWorkerFactory(undefined));
  const notifications: Array<{ method: string; params: { progressToken: string | number; progress: number; message?: string } }> = [];
  const extra = { _meta: { progressToken: "tok" }, sendNotification: async (notification: ServerNotification) => { notifications.push(notification as (typeof notifications)[number]); } };
  const task = (name: "indexProject" | "indexAll") => ({ name, paths, ms: 150 }) as unknown as WorkerTask;
  const results = await Promise.all([
    runWorkerTask<{ startedAt: number; finishedAt: number }>("bitrix_index_project", task("indexProject"), extra),
    runWorkerTask<{ startedAt: number; finishedAt: number }>("bitrix_index_all", task("indexAll"), extra)
  ]);
  const [first, second] = results.sort((a, b) => a.startedAt - b.startedAt);
  assert.ok(second.startedAt >= first.finishedAt, "index tasks must not overlap");
  assert.equal(indexMutex.isLocked, false);
  assert.ok(notifications.some((notification) => notification.params.message === "Waiting for another index task to finish"));
  assert.ok(notifications.some((notification) => notification.params.message === "project parse 1/2"));
  assert.ok(notifications.every((notification) => notification.method === "notifications/progress" && notification.params.progressToken === "tok"));
  const progress = notifications.map((notification) => notification.params.progress);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
});

test("runWorkerTask removes an aborted index task from the queue", async (t) => {
  await setTaskWorkerFactory(createFakeWorker);
  t.after(() => setTaskWorkerFactory(undefined));
  const running = runWorkerTask("bitrix_index_all", { name: "indexAll", paths, ms: 300 } as unknown as WorkerTask);
  const controller = new AbortController();
  const queued = runWorkerTask("bitrix_index_project", { name: "indexProject", paths } as WorkerTask, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(indexMutex.pending, 1);
  controller.abort();
  await assert.rejects(queued, /MCP tool bitrix_index_project was cancelled by the client/);
  assert.equal(indexMutex.pending, 0);
  await running;
});

test("closeWorkerPools cancels running and queued index tasks", async (t) => {
  await setTaskWorkerFactory(createFakeWorker);
  t.after(() => setTaskWorkerFactory(undefined));
  const running = runWorkerTask("bitrix_index_all", { name: "indexAll", paths, ms: 5000 } as unknown as WorkerTask);
  const queued = runWorkerTask("bitrix_index_project", { name: "indexProject", paths } as WorkerTask);
  const rejections = Promise.all([
    assert.rejects(running, /MCP tool bitrix_index_all was cancelled: the worker pool closed/),
    assert.rejects(queued, /MCP tool bitrix_index_project was cancelled: the worker pool closed/)
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await closeWorkerPools();
  await rejections;
  assert.equal(indexMutex.isLocked, false);
});

test("runWorkerTask runs read tasks on the shared pool", async (t) => {
  await setTaskWorkerFactory(createFakeWorker);
  t.after(() => setTaskWorkerFactory(undefined));
  const first = await runWorkerTask<{ threadId: number }>("t", { name: "echo", value: 1 } as unknown as WorkerTask);
  const second = await runWorkerTask<{ threadId: number }>("t", { name: "echo", value: 2 } as unknown as WorkerTask);
  assert.equal(first.threadId, second.threadId);
  assert.equal(readPoolStats()?.spawned, 1);
});

test("withMcpToolGuard rejects when the client cancels", async () => {
  const controller = new AbortController();
  const pending = withMcpToolGuard("bitrix_index_status", () => new Promise(() => undefined), { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  await assert.rejects(pending, /MCP tool bitrix_index_status was cancelled by the client/);
});
