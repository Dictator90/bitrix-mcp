import type { IndexProgressEvent, ProgressReporter } from "./types.js";

/**
 * Discards every progress event. Used for `--no-progress`, non-interactive
 * shells, CI, and any context where stdout/stderr must stay clean (MCP stdio).
 */
export class NoopProgressReporter implements ProgressReporter {
  start(_event: IndexProgressEvent): void {}
  update(_event: IndexProgressEvent): void {}
  warn(_message: string, _event?: Partial<IndexProgressEvent>): void {}
  error(_message: string, _event?: Partial<IndexProgressEvent>): void {}
  done(_event: IndexProgressEvent): void {}
}
