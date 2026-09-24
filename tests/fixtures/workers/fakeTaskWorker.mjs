// Stand-in for src/mcp/workerThread.ts speaking the same PoolRequest/PoolResponse protocol.
import { parentPort, threadId } from "node:worker_threads";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

parentPort.on("message", async ({ id, task, progress }) => {
  const reply = (result) => parentPort.postMessage({ id, type: "result", ok: true, result });
  switch (task.name) {
    case "echo":
      reply({ value: task.value, threadId });
      return;
    case "sleep":
      await sleep(task.ms);
      reply({ threadId });
      return;
    case "block": {
      const until = Date.now() + task.ms;
      while (Date.now() < until) { /* synchronous work that cannot be interrupted */ }
      reply({ threadId });
      return;
    }
    case "exit":
      process.exit(task.code ?? 0);
      return;
    case "throw":
      setImmediate(() => { throw new Error("fake worker crashed"); });
      return;
    case "fail":
      parentPort.postMessage({ id, type: "result", ok: false, error: "task failed on purpose" });
      return;
    default: {
      // Index-like tasks: report progress when asked and return their run window.
      const startedAt = Date.now();
      if (progress) parentPort.postMessage({ id, type: "progress", event: { scope: "project", phase: "parse", current: 1, total: 2 } });
      await sleep(task.ms ?? 50);
      reply({ name: task.name, startedAt, finishedAt: Date.now() });
    }
  }
});
