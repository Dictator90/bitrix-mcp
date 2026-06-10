import { formatDuration, formatNumber, percent } from "./format.js";
import type { ProgressStream } from "./jsonReporter.js";
import type { IndexProgressEvent, ProgressReporter } from "./types.js";

export interface TtyProgressReporterOptions {
  stream: ProgressStream;
  isTty?: boolean;
  columns?: number;
  useColor?: boolean;
  now?: () => number;
  intervalMs?: number;
}

const CLEAR_LINE = "\x1b[2K";
const PHASE_LABELS: Record<string, string> = {
  discover: "Discover files",
  filter: "Filter files",
  parse: "Parse files",
  relations: "Extract relations",
  write: "Write index",
  docs: "Index documentation",
  embeddings: "Index embeddings",
  finalize: "Finalize",
  done: "Done"
};

/**
 * Rich single-line progress for interactive terminals: a header per phase and
 * a live status line (rewritten in place on a TTY) showing current/total,
 * percentage, elapsed time and the current file. Updates are throttled.
 */
export class TtyProgressReporter implements ProgressReporter {
  private readonly stream: ProgressStream;
  private readonly isTty: boolean;
  private readonly columns: number;
  private readonly useColor: boolean;
  private readonly now: () => number;
  private readonly intervalMs: number;

  private lineActive = false;
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private phaseStartedAt = 0;
  private lastCurrent: number | undefined;
  private lastTotal: number | undefined;

  constructor(options: TtyProgressReporterOptions) {
    this.stream = options.stream;
    this.isTty = options.isTty ?? Boolean(options.stream.isTTY);
    this.columns = options.columns ?? options.stream.columns ?? 80;
    this.useColor = options.useColor ?? this.isTty;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 150;
  }

  private finishLine(): void {
    if (this.lineActive) {
      this.stream.write("\n");
      this.lineActive = false;
    }
  }

  private dim(text: string): string {
    return this.useColor ? `\x1b[2m${text}\x1b[0m` : text;
  }

  private truncate(text: string): string {
    const max = Math.max(10, this.columns - 1);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  private renderStatusLine(line: string): void {
    const truncated = this.truncate(line);
    if (this.isTty) {
      this.stream.write(`\r${CLEAR_LINE}${truncated}`);
      this.lineActive = true;
    } else {
      this.stream.write(`${truncated}\n`);
    }
  }

  start(event: IndexProgressEvent): void {
    this.finishLine();
    this.phaseStartedAt = this.now();
    this.lastRenderAt = Number.NEGATIVE_INFINITY;
    this.lastCurrent = undefined;
    this.lastTotal = undefined;
    const label = event.message ?? PHASE_LABELS[event.phase] ?? event.phase;
    this.stream.write(`${event.scope}: ${label}\n`);
  }

  update(event: IndexProgressEvent): void {
    // Track the latest counts regardless of throttling so phase completion can
    // flush the final state even if the last update was throttled away.
    if (event.current !== undefined) this.lastCurrent = event.current;
    if (event.total !== undefined) this.lastTotal = event.total;

    const timestamp = this.now();
    if (timestamp - this.lastRenderAt < this.intervalMs) {
      return;
    }
    this.lastRenderAt = timestamp;

    const segments: string[] = [];
    if (event.current !== undefined && event.total !== undefined) {
      segments.push(`${formatNumber(event.current)}/${formatNumber(event.total)}`);
      const pct = percent(event.current, event.total);
      if (pct) segments.push(pct);
    } else if (event.current !== undefined) {
      segments.push(formatNumber(event.current));
    }
    const elapsed = timestamp - this.phaseStartedAt;
    if (elapsed > 0) {
      segments.push(`${formatDuration(elapsed)} elapsed`);
    }
    if (event.current && event.total && event.current > 0) {
      const remaining = ((timestamp - this.phaseStartedAt) / event.current) * (event.total - event.current);
      if (Number.isFinite(remaining) && remaining > 0) {
        segments.push(`~${formatDuration(remaining)} left`);
      }
    }
    let line = `  ${segments.join(" | ")}`;
    if (event.file) {
      line += this.dim(` ${event.file}`);
    }
    this.renderStatusLine(line);
  }

  warn(message: string, _event?: Partial<IndexProgressEvent>): void {
    this.finishLine();
    this.stream.write(`Warning: ${message}\n`);
  }

  error(message: string, event?: Partial<IndexProgressEvent>): void {
    this.finishLine();
    const where = event?.file ? ` while parsing ${event.file}` : "";
    this.stream.write(`${this.useColor ? "\x1b[31m" : ""}✗ Failed${where}${this.useColor ? "\x1b[0m" : ""}\n`);
    this.stream.write(`${message}\n`);
  }

  done(event: IndexProgressEvent): void {
    if (event.phase !== "done") {
      // Flush the final state of this phase so the last visible line shows
      // completion (e.g. 74/74 | 100%) instead of a stale throttled value.
      if (this.lastTotal !== undefined && this.lastTotal > 0) {
        const elapsed = this.now() - this.phaseStartedAt;
        this.renderStatusLine(`  ${formatNumber(this.lastTotal)}/${formatNumber(this.lastTotal)} | 100% | ${formatDuration(elapsed)} elapsed`);
      }
      this.finishLine();
      this.lastCurrent = undefined;
      this.lastTotal = undefined;
      return;
    }
    this.finishLine();
    const parts: string[] = [];
    if (event.elapsedMs !== undefined) {
      parts.push(`Done in ${formatDuration(event.elapsedMs)}`);
    } else {
      parts.push("Done");
    }
    const metrics: Array<[string, number | undefined]> = [
      ["files", event.indexedFiles],
      ["skipped", event.skippedFiles],
      ["symbols", event.symbols],
      ["events", event.events],
      ["relations", event.relations],
      ["docs", event.docsChunks]
    ];
    const rendered = metrics
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
      .map(([label, value]) => `${label}: ${formatNumber(value)}`);
    const check = "✓";
    this.stream.write(`${check} ${[parts[0], ...rendered].join(" | ")}\n`);
  }
}
