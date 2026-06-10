import type { IndexProgressEvent, ProgressReporter } from "./types.js";

export interface ProgressStream {
  write(chunk: string): boolean | void;
  isTTY?: boolean;
  columns?: number;
}

export interface JsonProgressReporterOptions {
  stream: ProgressStream;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Emits JSON Lines progress to a stream (stderr by default). `start`, `done`,
 * `warn` and `error` are always emitted; high-frequency `update` events are
 * throttled so machine-readable output stays bounded during long indexing.
 */
export class JsonProgressReporter implements ProgressReporter {
  private readonly stream: ProgressStream;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private lastUpdateAt = Number.NEGATIVE_INFINITY;

  constructor(options: JsonProgressReporterOptions) {
    this.stream = options.stream;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 200;
  }

  private emit(event: IndexProgressEvent): void {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (value !== undefined) {
        payload[key] = value;
      }
    }
    this.stream.write(`${JSON.stringify(payload)}\n`);
  }

  start(event: IndexProgressEvent): void {
    this.emit({ status: "start", ...event });
  }

  update(event: IndexProgressEvent): void {
    const timestamp = this.now();
    if (timestamp - this.lastUpdateAt < this.intervalMs) {
      return;
    }
    this.lastUpdateAt = timestamp;
    this.emit({ status: "progress", ...event });
  }

  warn(message: string, event?: Partial<IndexProgressEvent>): void {
    this.emit({ scope: "all", phase: "finalize", ...event, status: "warning", message } as IndexProgressEvent);
  }

  error(message: string, event?: Partial<IndexProgressEvent>): void {
    this.emit({ scope: "all", phase: "finalize", ...event, status: "error", message } as IndexProgressEvent);
  }

  done(event: IndexProgressEvent): void {
    this.emit({ status: "done", ...event });
  }
}
