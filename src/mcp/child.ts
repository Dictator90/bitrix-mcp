import { runTask } from "./worker.js";

process.once("message", (task: unknown) => {
  runTask(task as never)
    .then((result) => {
      if (process.send) process.send({ ok: true, result });
    })
    .catch((error: unknown) => {
      if (process.send) {
        process.send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    });
});
