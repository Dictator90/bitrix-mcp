import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const HEAVY_TOOL_TIMEOUT_MS = 10 * 60_000;

export interface McpToolGuardOptions {
  timeoutMs?: number;
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

export async function withMcpToolGuard<T>(toolName: string, work: () => Promise<T>, options: McpToolGuardOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? defaultToolTimeoutMs();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP tool ${toolName} exceeded timeout of ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type WorkerSuccess<T> = { ok: true; result: T };
type WorkerFailure = { ok: false; error: string; stack?: string };
type WorkerMessage<T> = WorkerSuccess<T> | WorkerFailure;

function messageError(message: WorkerFailure): Error {
  const error = new Error(message.error);
  if (message.stack) error.stack = message.stack;
  return error;
}

async function runChildProcessTask<T>(toolName: string, workerData: unknown, timeoutMs: number): Promise<T> {
  const childUrl = new URL("./child.ts", import.meta.url);
  const child = fork(childUrl, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let timeout: NodeJS.Timeout | undefined;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });

  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`MCP tool ${toolName} was cancelled after exceeding timeout of ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      child.once("message", (message: WorkerMessage<T>) => {
        if (message.ok) {
          resolve(message.result);
          return;
        }
        reject(messageError(message));
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0 && signal == null) reject(new Error(`MCP tool ${toolName} child exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
      child.send(workerData as Parameters<typeof child.send>[0]);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!child.killed) child.kill();
  }
}

async function runWorkerThreadTask<T>(toolName: string, workerData: unknown, timeoutMs: number): Promise<T> {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`MCP tool ${toolName} was cancelled after exceeding timeout of ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      worker.once("message", (message: WorkerMessage<T>) => {
        if (message.ok) {
          resolve(message.result);
          return;
        }
        reject(messageError(message));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`MCP tool ${toolName} worker exited with code ${code}`));
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    await worker.terminate().catch(() => undefined);
  }
}

export async function runWorkerTask<T>(toolName: string, workerData: unknown, options: McpToolGuardOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? heavyToolTimeoutMs();
  return import.meta.url.endsWith(".ts")
    ? runChildProcessTask(toolName, workerData, timeoutMs)
    : runWorkerThreadTask(toolName, workerData, timeoutMs);
}
