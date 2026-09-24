import { parentPort } from "node:worker_threads";
import "../runtime/sqliteWarning.js";
import type { IndexProgressEvent, ProgressReporter } from "../progress/types.js";
import type { PoolRequest, PoolResponse } from "./workerPool.js";

// stdout belongs to the MCP stdio transport; anything a task prints goes to stderr instead.
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

// Task-worker entry: the task runner is imported dynamically so the SQLite
// warning filter above is installed before node:sqlite is loaded. The worker
// stays alive and runs one PoolRequest at a time until the parent terminates it.
const { runTask } = await import("./worker.js");

const PROGRESS_UPDATE_INTERVAL_MS = 250;

class RelayProgressReporter implements ProgressReporter {
  private lastUpdateAt = 0;

  constructor(private readonly post: (event: Partial<IndexProgressEvent>) => void) {}

  start(event: IndexProgressEvent): void {
    this.post(event);
  }

  update(event: IndexProgressEvent): void {
    const now = Date.now();
    if (now - this.lastUpdateAt < PROGRESS_UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt = now;
    this.post(event);
  }

  warn(message: string, event?: Partial<IndexProgressEvent>): void {
    this.post({ ...event, status: "warning", message });
  }

  error(message: string, event?: Partial<IndexProgressEvent>): void {
    this.post({ ...event, status: "error", message });
  }

  done(event: IndexProgressEvent): void {
    this.post(event);
  }
}

const port = parentPort;
if (port) {
  const reply = (message: PoolResponse) => port.postMessage(message);
  port.on("message", (request: PoolRequest) => {
    const reporter = request.progress ? new RelayProgressReporter((event) => reply({ id: request.id, type: "progress", event })) : undefined;
    runTask(request.task as Parameters<typeof runTask>[0], { reporter })
      .then((result) => reply({ id: request.id, type: "result", ok: true, result }))
      .catch((error: unknown) => {
        reply({
          id: request.id,
          type: "result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      });
  });
}
