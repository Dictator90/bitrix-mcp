import fs from "node:fs/promises";
import path from "node:path";
import { docsSourcesDir, sqlitePath } from "../config/paths.js";

export interface CleanOptions {
  /** Also remove the documentation checkouts under `docs-sources/`. */
  all?: boolean;
}

export interface CleanTarget {
  path: string;
  kind: "file" | "directory";
  /** Bytes on disk (recursive for directories). */
  bytes: number;
  description: string;
}

const SQLITE_SUFFIXES = ["", "-wal", "-shm", "-journal"];
const BENCHMARK_REPORTS = ["benchmark.json", "benchmark.md"];
/** Legacy JSON manifests (`project-index.json`, ...) written before the SQLite store. */
const LEGACY_INDEX = /^[a-z0-9_-]+-index\.json$/u;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sizeOf(target: string): Promise<number> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    total += await sizeOf(path.join(target, entry.name)).catch(() => 0);
  }
  return total;
}

async function candidate(dataDir: string, target: string, description: string): Promise<CleanTarget | undefined> {
  if (!isInside(dataDir, target)) {
    throw new Error(`Refusing to remove ${target}: it is outside the data directory ${dataDir}.`);
  }
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return undefined;
  }
  // A symlinked entry is removed as a link; its target is never followed.
  const kind = stat.isDirectory() ? "directory" : "file";
  return { path: target, kind, bytes: stat.isSymbolicLink() ? 0 : await sizeOf(target), description };
}

/**
 * Lists what `clean` removes from the data directory: the SQLite index (with
 * WAL/SHM/journal files), legacy JSON indexes and benchmark reports, plus the
 * `docs-sources/` checkouts with `all`. Generated skills/rules and any other
 * file in the data directory are kept. Every path is checked to be inside the
 * data directory.
 */
export async function planClean(dataDir: string, options: CleanOptions = {}): Promise<CleanTarget[]> {
  const root = path.resolve(dataDir);
  const targets: Array<CleanTarget | undefined> = [];
  const dbFile = sqlitePath(root);
  for (const suffix of SQLITE_SUFFIXES) {
    targets.push(await candidate(root, `${dbFile}${suffix}`, suffix ? `SQLite ${suffix.slice(1)} file` : "SQLite index"));
  }
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(root)).sort();
  } catch {
    entries = [];
  }
  for (const name of entries.filter((entry) => LEGACY_INDEX.test(entry))) {
    targets.push(await candidate(root, path.join(root, name), "legacy JSON index"));
  }
  for (const name of BENCHMARK_REPORTS) {
    targets.push(await candidate(root, path.join(root, name), "benchmark report"));
  }
  if (options.all) {
    targets.push(await candidate(root, docsSourcesDir(root), "documentation checkouts"));
  }
  return targets.filter((target): target is CleanTarget => target !== undefined);
}

/** Removes planned targets; returns the ones that failed with their error. */
export async function applyClean(dataDir: string, targets: CleanTarget[]): Promise<Array<{ target: CleanTarget; error: string }>> {
  const root = path.resolve(dataDir);
  const failures: Array<{ target: CleanTarget; error: string }> = [];
  for (const target of targets) {
    if (!isInside(root, target.path)) {
      failures.push({ target, error: "outside the data directory" });
      continue;
    }
    try {
      await fs.rm(target.path, { recursive: target.kind === "directory", force: true });
    } catch (error) {
      failures.push({ target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatCleanPlan(dataDir: string, targets: CleanTarget[], options: { mode: "dry-run" | "confirm" | "remove"; all: boolean }): string {
  if (targets.length === 0) {
    return `Nothing to clean in ${dataDir}.`;
  }
  const total = targets.reduce((sum, target) => sum + target.bytes, 0);
  const verbs = { "dry-run": "Dry run: would remove", confirm: "This will remove", remove: "Removing" };
  const lines = [`${verbs[options.mode]} ${targets.length} item${targets.length === 1 ? "" : "s"} (${formatBytes(total)}) from ${dataDir}:`];
  for (const target of targets) {
    lines.push(`- ${path.relative(dataDir, target.path).replace(/\\/gu, "/")}${target.kind === "directory" ? "/" : ""} (${target.description}, ${formatBytes(target.bytes)})`);
  }
  if (!options.all) {
    lines.push("Kept: docs-sources/ checkouts (pass --all to remove them too).");
  }
  lines.push("Note: registered documentation sources live in the SQLite index; re-add custom ones with docs-add-git/docs-add-path after index-docs.");
  return lines.join("\n");
}
