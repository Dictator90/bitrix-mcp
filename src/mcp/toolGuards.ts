import type { Worker } from "node:worker_threads";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { AsyncMutex } from "./asyncMutex.js";
import type { WorkerTask } from "./worker.js";
import { cancelledError, WorkerPool, type WorkerPoolStats } from "./workerPool.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const HEAVY_TOOL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POOL_SIZE = 2;
const MAX_POOL_SIZE = 16;

/**
 * Per-call options. The MCP SDK's tool-callback `extra` argument fits this
 * shape, so handlers can pass it straight through for cancellation
 * (`signal`) and progress notifications (`_meta.progressToken`).
 */
export interface McpToolGuardOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

export function toolTimeoutMs(envName: string, fallback = DEFAULT_TOOL_TIMEOUT_MS): number {
  const raw = process.env[envName] ?? process.env.BITRIX_MCP_TOOL_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultToolTimeoutMs(): number {
  return toolTimeoutMs("BITRIX_MCP_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS);
}

export function heavyToolTimeoutMs(): number {
  return toolTimeoutMs("BITRIX_MCP_HEAVY_TOOL_TIMEOUT_MS", HEAVY_TOOL_TIMEOUT_MS);
}

export function workerPoolSize(): number {
  const parsed = Number(process.env.BITRIX_MCP_WORKERS);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_POOL_SIZE) : DEFAULT_POOL_SIZE;
}

/** Tasks that write the SQLite index: serialized through {@link indexMutex}. */
const INDEX_TASKS = new Set(["indexProject", "indexTemplate", "indexAll", "indexDocs"]);
/** Long-running or side-effecting tasks: each runs in its own worker with the heavy timeout. */
const HEAVY_TASKS = new Set([...INDEX_TASKS, "tinker", "dbExecute"]);

export type WorkerTaskClass = "read" | "heavy" | "index";

export function classifyWorkerTask(name: string): WorkerTaskClass {
  if (INDEX_TASKS.has(name)) return "index";
  return HEAVY_TASKS.has(name) ? "heavy" : "read";
}

export async function withMcpToolGuard<T>(toolName: string, work: () => Promise<T>, options: McpToolGuardOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? defaultToolTimeoutMs();
  const { signal } = options;
  if (signal?.aborted) throw cancelledError(toolName);
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP tool ${toolName} exceeded timeout of ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
        if (signal) {
          onAbort = () => reject(cancelledError(toolName));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

let readPool: WorkerPool | undefined;
let workerFactory: (() => Worker) | undefined;
const heavyPools = new Set<WorkerPool>();
let shutdown = new AbortController();
export const indexMutex = new AsyncMutex();

function getReadPool(): WorkerPool {
  readPool ??= new WorkerPool({ size: workerPoolSize(), respawnOnKill: true, createWorker: workerFactory });
  return readPool;
}

/** Test hook: closes the pools and replaces the task-worker factory (undefined restores the default). */
export async function setTaskWorkerFactory(factory: (() => Worker) | undefined): Promise<void> {
  await closeWorkerPools();
  workerFactory = factory;
}

export function readPoolStats(): WorkerPoolStats | undefined {
  return readPool?.stats();
}

/** Terminates the read pool and any running heavy task; called when the MCP server closes. */
export async function closeWorkerPools(): Promise<void> {
  const pools = [...heavyPools, ...(readPool ? [readPool] : [])];
  readPool = undefined;
  heavyPools.clear();
  shutdown.abort();
  shutdown = new AbortController();
  await Promise.all(pools.map((pool) => pool.close()));
}

type ProgressFields = { scope?: string; phase?: string; status?: string; message?: string; current?: number; total?: number };

function progressMessage(event: ProgressFields): string {
  const parts = [event.scope, event.phase].filter(Boolean).join(" ");
  const counter = event.current !== undefined && event.total !== undefined ? ` ${event.current}/${event.total}` : "";
  return `${parts}${counter}${event.message ? `: ${event.message}` : ""}`.trim();
}

function progressNotifier(options: McpToolGuardOptions): ((message: string) => void) | undefined {
  const progressToken = options._meta?.progressToken;
  const send = options.sendNotification;
  if (progressToken === undefined || !send) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    void send({ method: "notifications/progress", params: { progressToken, progress, message } }).catch(() => undefined);
  };
}

async function runHeavyTask<T>(toolName: string, workerData: WorkerTask, timeoutMs: number, options: McpToolGuardOptions, notify?: (message: string) => void): Promise<T> {
  const pool = new WorkerPool({ size: 1, createWorker: workerFactory });
  heavyPools.add(pool);
  try {
    return await pool.run<T>(toolName, workerData, {
      timeoutMs,
      signal: options.signal,
      onProgress: notify ? (event) => notify(progressMessage(event as ProgressFields)) : undefined
    });
  } finally {
    heavyPools.delete(pool);
    await pool.close();
  }
}

/**
 * Runs a {@link runTask} task off the main thread. Read tasks share a pool of
 * long-lived workers (BITRIX_MCP_WORKERS, default 2) with the default timeout;
 * index, tinker, and DB write tasks get a dedicated worker with the heavy
 * timeout, and index tasks queue behind each other so they never contend for
 * the SQLite write lock. The timeout of a queued index task starts once it runs.
 */
export async function runWorkerTask<T>(toolName: string, workerData: WorkerTask, options: McpToolGuardOptions = {}): Promise<T> {
  const taskClass = classifyWorkerTask(workerData.name);
  if (taskClass === "read") {
    return getReadPool().run<T>(toolName, workerData, { timeoutMs: options.timeoutMs ?? defaultToolTimeoutMs(), signal: options.signal });
  }
  const timeoutMs = options.timeoutMs ?? heavyToolTimeoutMs();
  const notify = progressNotifier(options);
  if (taskClass === "heavy") return runHeavyTask<T>(toolName, workerData, timeoutMs, options, notify);
  if (options.signal?.aborted) throw cancelledError(toolName);
  if (indexMutex.isLocked) notify?.("Waiting for another index task to finish");
  let release: () => void;
  try {
    release = await indexMutex.acquire(options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal);
  } catch {
    throw options.signal?.aborted ? cancelledError(toolName) : new Error(`MCP tool ${toolName} was cancelled: the worker pool closed`);
  }
  try {
    return await runHeavyTask<T>(toolName, workerData, timeoutMs, options, notify);
  } finally {
    release();
  }
}
