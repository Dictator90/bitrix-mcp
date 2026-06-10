import { formatDuration, formatNumber } from "./format.js";
import type { ProgressStream } from "./jsonReporter.js";
import type { IndexProgressEvent, IndexScope, ProgressReporter } from "./types.js";

export interface CompactProgressReporterOptions {
  stream: ProgressStream;
  useUnicode?: boolean;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Very short progress: a dot per chunk of work, a check per completed phase,
 * one line per scope, and a single summary line per scope completion. Ideal
 * for long jobs and logs. Dots are throttled to avoid spamming the terminal.
 */
export class CompactProgressReporter implements ProgressReporter {
  private readonly stream: ProgressStream;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly check: string;
  private readonly cross: string;
  private readonly summaryMark: string;

  private currentScope: IndexScope | null = null;
  private lineOpen = false;
  private lastDotAt = Number.NEGATIVE_INFINITY;

  constructor(options: CompactProgressReporterOptions) {
    this.stream = options.stream;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 700;
    const unicode = options.useUnicode ?? true;
    this.check = unicode ? "✓" : "v";
    this.cross = unicode ? "✗" : "x";
    this.summaryMark = unicode ? "✓" : "done";
  }

  private write(chunk: string): void {
    this.stream.write(chunk);
  }

  private ensureLine(scope: IndexScope): void {
    if (this.currentScope === scope && this.lineOpen) {
      return;
    }
    if (this.lineOpen) {
      this.write("\n");
    }
    this.write(`${scope.padEnd(9)} `);
    this.currentScope = scope;
    this.lineOpen = true;
    this.lastDotAt = Number.NEGATIVE_INFINITY;
  }

  start(event: IndexProgressEvent): void {
    this.ensureLine(event.scope);
  }

  update(event: IndexProgressEvent): void {
    this.ensureLine(event.scope);
    const timestamp = this.now();
    if (timestamp - this.lastDotAt < this.intervalMs) {
      return;
    }
    this.lastDotAt = timestamp;
    this.write(".");
  }

  warn(message: string, event?: Partial<IndexProgressEvent>): void {
    this.closeLine();
    const mark = this.cross === "✗" ? "⚠" : "!";
    this.write(`${mark} ${message}\n`);
  }

  error(message: string, event?: Partial<IndexProgressEvent>): void {
    if (event?.scope) {
      this.ensureLine(event.scope);
      this.write(` ${this.cross}`);
    }
    this.closeLine();
    this.write(`Failed: ${message}\n`);
  }

  done(event: IndexProgressEvent): void {
    this.ensureLine(event.scope);
    this.write(` ${this.check}`);
    if (event.phase === "done") {
      this.write(`\n${this.summaryLine(event)}\n`);
      this.closeLine();
    }
  }

  private closeLine(): void {
    if (this.lineOpen) {
      this.write("\n");
    }
    this.lineOpen = false;
    this.currentScope = null;
    this.lastDotAt = Number.NEGATIVE_INFINITY;
  }

  private summaryLine(event: IndexProgressEvent): string {
    const parts: string[] = [];
    if (event.elapsedMs !== undefined) {
      parts.push(`${this.summaryMark} ${event.scope} indexed in ${formatDuration(event.elapsedMs)}`);
    } else {
      parts.push(`${this.summaryMark} ${event.scope} indexed`);
    }
    const metrics: Array<[string, number | undefined]> = [
      ["files", event.indexedFiles],
      ["skipped", event.skippedFiles],
      ["symbols", event.symbols],
      ["relations", event.relations],
      ["docs", event.docsChunks]
    ];
    const rendered = metrics
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
      .map(([label, value]) => `${label}: ${formatNumber(value)}`);
    return [parts[0], ...rendered].join(" | ");
  }
}
