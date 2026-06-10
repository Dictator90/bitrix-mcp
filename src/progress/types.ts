export type IndexScope =
  | "project"
  | "template"
  | "bitrix"
  | "install"
  | "docs"
  | "code"
  | "all";

export type IndexPhase =
  | "discover"
  | "filter"
  | "parse"
  | "relations"
  | "write"
  | "docs"
  | "embeddings"
  | "finalize"
  | "done";

export type IndexProgressStatus = "start" | "progress" | "done" | "skip" | "warning" | "error";

export interface IndexProgressEvent {
  scope: IndexScope;
  phase: IndexPhase;

  status?: IndexProgressStatus;

  message?: string;

  current?: number;
  total?: number;

  file?: string;
  module?: string;

  foundFiles?: number;
  ignoredFiles?: number;
  queuedFiles?: number;
  indexedFiles?: number;
  skippedFiles?: number;

  symbols?: number;
  events?: number;
  relations?: number;
  docsChunks?: number;

  startedAt?: number;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
}

export interface ProgressReporter {
  start(event: IndexProgressEvent): void;
  update(event: IndexProgressEvent): void;
  warn(message: string, event?: Partial<IndexProgressEvent>): void;
  error(message: string, event?: Partial<IndexProgressEvent>): void;
  done(event: IndexProgressEvent): void;
}
