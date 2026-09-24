import { parentPort } from "node:worker_threads";
import { parseFile } from "./parseFile.js";

// Parse worker: receives { id, absolutePath, language } and replies with the parsed file or an error.
parentPort?.on("message", (request: { id: number; absolutePath: string; language: string; relativePath?: string }) => {
  parseFile(request.absolutePath, request.language, request.relativePath)
    .then((result) => parentPort?.postMessage({ id: request.id, ok: true, result }))
    .catch((error: unknown) => parentPort?.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
});
