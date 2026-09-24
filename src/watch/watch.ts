import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../config/paths.js";
import { buildIndex } from "../indexer/indexer.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import type { IndexProgressEvent, ProgressReporter } from "../progress/types.js";
import { mergeReindexTargets, relativeInside, WatchScopeMapper, type ReindexTarget, type WatchScope, type WatchScopeOptions } from "./scope.js";

export interface WatchOptions extends WatchScopeOptions {
  /** Quiet period before a batch of changes is re-indexed (default 500 ms). */
  debounceMs?: number;
  /**
   * How directories are watched. "native" uses `fs.watch(root, { recursive: true })`;
   * "tree" watches each relevant directory separately and never descends into
   * ignored trees (cache/upload/node_modules/...), which keeps the inotify
   * watch count low on Linux. Defaults to "tree" on Linux, "native" elsewhere.
   */
  mode?: "native" | "tree";
  /** Receives every watch event (ready, reindex, error, stopped). */
  onEvent?: (event: WatchEvent) => void;
}

export type WatchEvent =
  | { event: "ready"; roots: string[]; scopes: WatchScope[]; mode: "native" | "tree"; directories: number }
  | { event: "reindex"; scope: WatchScope; path?: string; changed: string[]; files: number; parsedFiles: number; unchangedFiles: number; docChunks?: number; warnings: number; elapsedMs: number }
  | { event: "error"; scope?: WatchScope; path?: string; message: string }
  | { event: "stopped" };

export interface WatchHandle {
  /** Directories being watched. */
  readonly roots: string[];
  /** Stops watching and waits for an in-flight re-index to finish. */
  stop(): Promise<void>;
  /** Resolves once no batch is pending or running. */
  idle(): Promise<void>;
}

const MAX_CHANGED_IN_EVENT = 20;

/** Captures the per-run counters buildIndex reports through its progress events. */
class SummaryReporter implements ProgressReporter {
  indexedFiles = 0;
  skippedFiles = 0;
  start(): void {}
  update(): void {}
  warn(): void {}
  error(): void {}
  done(event: IndexProgressEvent): void {
    if (event.phase === "done") {
      this.indexedFiles = event.indexedFiles ?? this.indexedFiles;
      this.skippedFiles = event.skippedFiles ?? this.skippedFiles;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Watches the workspace (plus an external Bitrix root and, with `docs`, the
 * documentation directories) and incrementally re-indexes the scopes touched
 * by each debounced batch of changes. buildIndex skips unchanged files by
 * size/mtime and prunes only under the scanned directory, so each run costs a
 * directory walk plus parsing of the changed files.
 */
export async function startWatch(paths: RuntimePaths, options: WatchOptions = {}): Promise<WatchHandle> {
  const docsRoots = options.docs ? await existingDirectories(paths.docsPaths) : [];
  const mapper = await WatchScopeMapper.create(paths, options, docsRoots);
  const roots = mapper.watchRoots();
  const mode = options.mode ?? (process.platform === "linux" ? "tree" : "native");
  const debounceMs = options.debounceMs ?? 500;
  const emit = options.onEvent ?? (() => undefined);

  const pending = new Map<string, { target: ReindexTarget; changed: Set<string> }>();
  let timer: NodeJS.Timeout | undefined;
  let firstPendingAt = 0;
  let running: Promise<void> | undefined;
  let stopped = false;
  let reloadIgnores = false;
  const idleWaiters: Array<() => void> = [];

  const displayPath = (absolutePath: string): string => relativeInside(mapper.workspaceRoot, absolutePath) ?? absolutePath.replace(/\\/gu, "/");

  const settleIdle = () => {
    if (!running && pending.size === 0 && !timer) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // Trailing debounce, but never hold a batch longer than 10 quiet periods.
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + debounceMs * 10 - Date.now()));
    timer = setTimeout(() => {
      timer = undefined;
      kick();
    }, wait);
  };

  const kick = () => {
    if (running || stopped) return;
    running = drain().finally(() => {
      running = undefined;
      if (pending.size > 0 && !stopped) schedule();
      settleIdle();
    });
  };

  const enqueue = (absolutePath: string, isDirectory: boolean) => {
    if (stopped || mapper.isDataPath(absolutePath)) return;
    const base = path.basename(absolutePath);
    if (base === ".gitignore" || base === ".bitrixmcpignore") reloadIgnores = true;
    const targets = mapper.classify(absolutePath, isDirectory);
    if (targets.length === 0) return;
    if (pending.size === 0) firstPendingAt = Date.now();
    for (const target of targets) {
      const entry = pending.get(target.key) ?? { target, changed: new Set<string>() };
      entry.changed.add(displayPath(absolutePath));
      pending.set(target.key, entry);
    }
    schedule();
  };

  async function drain(): Promise<void> {
    while (pending.size > 0 && !stopped) {
      if (reloadIgnores) {
        reloadIgnores = false;
        await mapper.reloadIgnoreFiles();
      }
      const batch = [...pending.values()];
      pending.clear();
      for (const target of mergeReindexTargets(batch.map((entry) => entry.target))) {
        if (stopped) break;
        // A merged target also reports the changes of the directory runs it absorbed.
        const changed = new Set<string>();
        for (const entry of batch) {
          const absorbed = entry.target.scope === target.scope
            && (target.subPath === undefined || entry.target.subPath === target.subPath || entry.target.subPath?.startsWith(`${target.subPath}/`));
          if (absorbed) for (const item of entry.changed) changed.add(item);
        }
        await runTarget(target, [...changed].sort());
      }
    }
  }

  async function runTarget(target: ReindexTarget, changed: string[]): Promise<void> {
    const startedAt = Date.now();
    const shownChanged = changed.slice(0, MAX_CHANGED_IN_EVENT);
    try {
      if (target.scope === "docs") {
        const docChunks = await indexDocResourcesToSqlite(paths.dataDir, docsRoots, { includeOfficialDocs: false });
        emit({ event: "reindex", scope: "docs", changed: shownChanged, files: 0, parsedFiles: 0, unchangedFiles: 0, docChunks, warnings: 0, elapsedMs: Date.now() - startedAt });
        return;
      }
      const reporter = new SummaryReporter();
      const manifest = await buildIndex({ ...(target.index as NonNullable<ReindexTarget["index"]>), reporter });
      const files = manifest.files.length;
      emit({
        event: "reindex",
        scope: target.scope,
        ...(target.subPath ? { path: target.subPath } : {}),
        changed: shownChanged,
        files,
        parsedFiles: Math.max(0, files - reporter.skippedFiles),
        unchangedFiles: reporter.skippedFiles,
        warnings: manifest.warnings?.length ?? 0,
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      emit({ event: "error", scope: target.scope, ...(target.subPath ? { path: target.subPath } : {}), message: errorMessage(error) });
    }
  }

  const onWatchError = (root: string) => (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code;
    const hint = code === "ENOSPC" ? " (inotify watch limit reached; raise fs.inotify.max_user_watches)" : "";
    emit({ event: "error", path: displayPath(root), message: `${errorMessage(error)}${hint}` });
  };

  const watchers = new Map<string, fs.FSWatcher>();
  const closeUnder = (absoluteDir: string) => {
    for (const [dir, watcher] of watchers) {
      if (relativeInside(absoluteDir, dir) !== undefined) {
        watcher.close();
        watchers.delete(dir);
      }
    }
  };

  /** Handles one raw fs.watch notification for `absolutePath`. */
  const onChange = async (eventType: string, absolutePath: string) => {
    let stat: fs.Stats | undefined;
    try {
      stat = await fsp.lstat(absolutePath);
    } catch {
      stat = undefined;
    }
    if (stat?.isSymbolicLink()) return;
    if (stat?.isDirectory()) {
      // Directory mtime/attribute changes carry no information; only a created
      // or moved-in directory ("rename") needs indexing (and, in tree mode, watching).
      if (eventType !== "rename") return;
      if (mode === "tree" && !watchers.has(absolutePath) && mapper.shouldWatchDirectory(absolutePath)) {
        await watchTree(absolutePath);
      }
      enqueue(absolutePath, true);
      return;
    }
    if (!stat) {
      // Deleted or moved away: a known directory, or an extension-less path, is treated as a directory.
      const wasWatched = [...watchers.keys()].some((dir) => relativeInside(absolutePath, dir) !== undefined);
      if (mode === "tree") closeUnder(absolutePath);
      enqueue(absolutePath, wasWatched || path.extname(absolutePath) === "");
      return;
    }
    enqueue(absolutePath, false);
  };

  const handle = (dir: string) => (eventType: string, filename: string | Buffer | null) => {
    if (stopped || filename === null) return;
    const absolutePath = path.join(dir, filename.toString());
    void onChange(eventType, absolutePath).catch((error: unknown) => emit({ event: "error", path: displayPath(absolutePath), message: errorMessage(error) }));
  };

  async function watchTree(dir: string): Promise<void> {
    const queue = [dir];
    while (queue.length > 0 && !stopped) {
      const current = queue.shift() as string;
      if (watchers.has(current)) continue;
      try {
        const watcher = fs.watch(current, { persistent: true }, handle(current));
        watcher.on("error", (error) => {
          watcher.close();
          watchers.delete(current);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EPERM") onWatchError(current)(error);
        });
        watchers.set(current, watcher);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        onWatchError(current)(error as Error);
        if (code === "ENOSPC" || code === "EMFILE") return;
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(current, entry.name);
        if (mapper.shouldWatchDirectory(child)) queue.push(child);
      }
    }
  }

  for (const root of roots) {
    if (mode === "tree") {
      await watchTree(root);
    } else {
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: true }, handle(root));
        watcher.on("error", onWatchError(root));
        watchers.set(root, watcher);
      } catch (error) {
        onWatchError(root)(error as Error);
      }
    }
  }

  emit({ event: "ready", roots: roots.map((root) => root.replace(/\\/gu, "/")), scopes: mapper.scopes(), mode, directories: watchers.size });

  return {
    roots,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      pending.clear();
      await running;
      settleIdle();
      emit({ event: "stopped" });
    },
    idle() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    }
  };
}

async function existingDirectories(candidates: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(candidate)).isDirectory()) result.push(path.resolve(candidate));
    } catch {
      // Missing docs directories are skipped, as in index-docs.
    }
  }
  return result;
}

/** One-line, human-readable rendering of a watch event. */
export function formatWatchEvent(event: WatchEvent): string {
  const time = new Date().toTimeString().slice(0, 8);
  switch (event.event) {
    case "ready":
      return `Watching ${event.roots.join(", ")} (${event.scopes.join(", ")}; ${event.directories} ${event.mode === "tree" ? "directories" : "recursive watchers"}). Press Ctrl+C to stop.`;
    case "reindex": {
      const where = event.path ? `${event.scope} ${event.path}` : event.scope;
      const changed = event.changed.length === 1 ? event.changed[0] : `${event.changed.length}${event.changed.length >= MAX_CHANGED_IN_EVENT ? "+" : ""} changes`;
      const counts = event.scope === "docs"
        ? `${event.docChunks ?? 0} doc chunks`
        : `${event.parsedFiles} parsed, ${event.unchangedFiles} unchanged${event.warnings ? `, ${event.warnings} warnings` : ""}`;
      return `[${time}] ${where}: ${changed} -> ${counts} (${event.elapsedMs} ms)`;
    }
    case "error":
      return `[${time}] error${event.scope ? ` in ${event.scope}` : ""}${event.path ? ` ${event.path}` : ""}: ${event.message}`;
    case "stopped":
      return "Stopped watching.";
  }
}
