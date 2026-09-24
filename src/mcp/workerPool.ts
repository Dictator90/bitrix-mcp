import { SHARE_ENV, Worker, type WorkerOptions } from "node:worker_threads";

export interface PoolRequest {
  id: number;
  task: unknown;
  progress?: boolean;
}

export type PoolResponse =
  | { id: number; type: "result"; ok: true; result: unknown }
  | { id: number; type: "result"; ok: false; error: string; stack?: string }
  | { id: number; type: "progress"; event: unknown };

export interface PoolRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (event: unknown) => void;
}

export interface WorkerPoolOptions {
  size: number;
  createWorker?: () => Worker;
  /** Spawn a replacement right away when a worker is killed for a timeout or cancellation. */
  respawnOnKill?: boolean;
}

export interface WorkerPoolStats {
  size: number;
  workers: number;
  busy: number;
  queued: number;
  spawned: number;
}

interface PendingTask {
  id: number;
  label: string;
  task: unknown;
  options: PoolRunOptions;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  slot?: Slot;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
}

interface Slot {
  worker: Worker;
  task?: PendingTask;
  lastError?: Error;
}

/**
 * Starts a task worker running `workerThread` (the {@link PoolRequest} loop).
 * From TypeScript sources (tests, dev) the worker registers tsx first, because
 * `--import tsx` in a worker's execArgv does not apply the loader there.
 */
export function createTaskWorker(): Worker {
  const fromSource = import.meta.url.endsWith(".ts");
  const entry = new URL(fromSource ? "./workerThread.ts" : "./workerThread.js", import.meta.url);
  const options: WorkerOptions = { env: SHARE_ENV };
  return fromSource
    ? new Worker(`import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};\nregister();\nawait import(${JSON.stringify(entry.href)});\n`, { ...options, eval: true })
    : new Worker(entry, options);
}

/**
 * Long-lived worker threads that run tasks one at a time each. Workers are
 * spawned lazily up to `size`, kept `unref`'d while idle, and replaced after a
 * crash, a timeout, or a cancellation (the latter two terminate the worker
 * because synchronous SQLite work cannot be interrupted).
 */
export class WorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly queue: PendingTask[] = [];
  private readonly createWorker: () => Worker;
  private nextId = 1;
  private spawned = 0;
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions) {
    this.createWorker = options.createWorker ?? createTaskWorker;
  }

  stats(): WorkerPoolStats {
    let busy = 0;
    for (const slot of this.slots) if (slot.task) busy += 1;
    return { size: this.options.size, workers: this.slots.size, busy, queued: this.queue.length, spawned: this.spawned };
  }

  run<T>(label: string, task: unknown, options: PoolRunOptions): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`MCP tool ${label} could not run: the worker pool is closed`));
    if (options.signal?.aborted) return Promise.reject(cancelledError(label));
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask = { id: this.nextId++, label, task, options, resolve: resolve as (value: unknown) => void, reject };
      pending.timer = setTimeout(() => this.cancel(pending, new Error(`MCP tool ${label} was cancelled after exceeding timeout of ${options.timeoutMs}ms`)), options.timeoutMs);
      pending.timer.unref?.();
      if (options.signal) {
        pending.onAbort = () => this.cancel(pending, cancelledError(label));
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) this.settle(pending, new Error(`MCP tool ${pending.label} was cancelled: the worker pool closed`));
    const slots = [...this.slots];
    this.slots.clear();
    for (const slot of slots) {
      if (slot.task) this.settle(slot.task, new Error(`MCP tool ${slot.task.label} was cancelled: the worker pool closed`));
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => undefined)));
  }

  private dispatch(): void {
    while (!this.closed && this.queue.length > 0) {
      const slot = this.idleSlot() ?? (this.slots.size < this.options.size ? this.spawn() : undefined);
      if (!slot) return;
      const pending = this.queue.shift()!;
      pending.slot = slot;
      slot.task = pending;
      slot.worker.ref();
      const request: PoolRequest = { id: pending.id, task: pending.task, progress: pending.options.onProgress !== undefined };
      slot.worker.postMessage(request);
    }
  }

  private idleSlot(): Slot | undefined {
    for (const slot of this.slots) if (!slot.task) return slot;
    return undefined;
  }

  private spawn(): Slot {
    const worker = this.createWorker();
    const slot: Slot = { worker };
    this.spawned += 1;
    this.slots.add(slot);
    worker.unref();
    worker.on("message", (message: PoolResponse) => this.onMessage(slot, message));
    worker.on("error", (error: Error) => { slot.lastError = error; });
    worker.on("exit", (code: number) => this.onExit(slot, code));
    return slot;
  }

  private onMessage(slot: Slot, message: PoolResponse): void {
    const pending = slot.task;
    if (!pending || message.id !== pending.id) return;
    if (message.type === "progress") {
      pending.options.onProgress?.(message.event);
      return;
    }
    slot.task = undefined;
    slot.worker.unref();
    if (message.ok) {
      this.settle(pending, undefined, message.result);
    } else {
      const error = new Error(message.error);
      if (message.stack) error.stack = message.stack;
      this.settle(pending, error);
    }
    this.dispatch();
  }

  private onExit(slot: Slot, code: number): void {
    if (!this.slots.delete(slot)) return;
    const pending = slot.task;
    slot.task = undefined;
    if (pending) {
      const detail = slot.lastError ? `: ${slot.lastError.message}` : "";
      this.settle(pending, new Error(`MCP tool ${pending.label} worker exited unexpectedly with code ${code}${detail}`));
    }
    this.dispatch();
  }

  private cancel(pending: PendingTask, error: Error): void {
    const slot = pending.slot;
    if (!slot) {
      const index = this.queue.indexOf(pending);
      if (index >= 0) this.queue.splice(index, 1);
      this.settle(pending, error);
      return;
    }
    if (slot.task !== pending) return;
    slot.task = undefined;
    this.slots.delete(slot);
    void slot.worker.terminate().catch(() => undefined);
    this.settle(pending, error);
    if (!this.closed && this.options.respawnOnKill && this.slots.size < this.options.size) this.spawn();
    this.dispatch();
  }

  private settle(pending: PendingTask, error: Error | undefined, result?: unknown): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.onAbort) pending.options.signal?.removeEventListener("abort", pending.onAbort);
    pending.timer = undefined;
    pending.onAbort = undefined;
    pending.slot = undefined;
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(result);
    }
  }
}

export function cancelledError(label: string): Error {
  return new Error(`MCP tool ${label} was cancelled by the client`);
}
