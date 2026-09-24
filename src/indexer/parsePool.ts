import os from "node:os";
import { Worker } from "node:worker_threads";
import type { ParsedFile } from "./parseFile.js";

export const INDEX_WORKERS_ENV = "BITRIX_MCP_INDEX_WORKERS";

/** Parse worker threads to use: BITRIX_MCP_INDEX_WORKERS, else CPUs − 1 capped at 4. 1 means parse in-process. */
export function indexWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[INDEX_WORKERS_ENV]);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, 16);
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

function createParseWorker(): Worker {
  if (!import.meta.url.endsWith(".ts")) return new Worker(new URL("./parseWorker.js", import.meta.url));
  // Running from TypeScript sources (tests, dev): register the tsx loader inside the worker first.
  const entry = new URL("./parseWorker.ts", import.meta.url).href;
  const tsxApi = import.meta.resolve("tsx/esm/api");
  return new Worker(`import(${JSON.stringify(tsxApi)}).then(({ register }) => { register(); return import(${JSON.stringify(entry)}); });`, { eval: true });
}

interface PendingParse {
  resolve: (result: ParsedFile) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingParse>;
}

/**
 * A fixed set of worker threads that parse files (PHP via php-parser, JS/TS via
 * the TypeScript compiler) in parallel. Requests are spread round-robin; a
 * crashed worker rejects its in-flight requests and is replaced.
 */
export class ParsePool {
  private readonly workers: PoolWorker[] = [];
  private nextId = 1;
  private nextWorker = 0;
  private closed = false;

  constructor(private readonly size: number) {}

  parse(absolutePath: string, language: string, relativePath?: string): Promise<ParsedFile> {
    if (this.closed) return Promise.reject(new Error("Parse pool is closed."));
    const slot = this.nextWorker % this.size;
    this.nextWorker += 1;
    const poolWorker = this.workers[slot] ?? this.spawn(slot);
    const id = this.nextId++;
    return new Promise<ParsedFile>((resolve, reject) => {
      poolWorker.pending.set(id, { resolve, reject });
      poolWorker.worker.postMessage({ id, absolutePath, language, relativePath });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((poolWorker) => poolWorker?.worker.terminate()));
    this.workers.length = 0;
  }

  private spawn(slot: number): PoolWorker {
    const poolWorker: PoolWorker = { worker: createParseWorker(), pending: new Map() };
    const failAll = (error: Error) => {
      for (const pending of poolWorker.pending.values()) pending.reject(error);
      poolWorker.pending.clear();
      if (this.workers[slot] === poolWorker) delete this.workers[slot];
    };
    poolWorker.worker.on("message", (message: { id: number; ok: boolean; result?: ParsedFile; error?: string }) => {
      const pending = poolWorker.pending.get(message.id);
      if (!pending) return;
      poolWorker.pending.delete(message.id);
      if (message.ok && message.result) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "Parse worker failed."));
    });
    poolWorker.worker.on("error", failAll);
    poolWorker.worker.on("exit", (code) => {
      if (!this.closed) failAll(new Error(`Parse worker exited with code ${code}.`));
    });
    this.workers[slot] = poolWorker;
    return poolWorker;
  }
}
