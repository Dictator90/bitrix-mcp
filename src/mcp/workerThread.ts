import { parentPort, workerData } from "node:worker_threads";
import "../runtime/sqliteWarning.js";

// Worker-thread entry: the task runner is imported dynamically so the SQLite
// warning filter above is installed before node:sqlite is loaded.
const { runTask } = await import("./worker.js");

const activeParentPort = parentPort;
if (activeParentPort) {
  runTask(workerData as Parameters<typeof runTask>[0])
    .then((result) => activeParentPort.postMessage({ ok: true, result }))
    .catch((error: unknown) => {
      activeParentPort.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    });
}
