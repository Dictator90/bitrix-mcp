import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE = "HEAD~1";
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/~@+-]{0,200}$/u;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Untracked files beyond this count are dropped with a warning (e.g. an unignored bitrix/ core checkout). */
export const MAX_UNTRACKED_FILES = 5000;

export type GitFileStatus = "added" | "modified" | "deleted" | "type_changed" | "unmerged" | "untracked" | "unknown";

export interface GitChangedFile {
  /** Path relative to the workspace root, slash-normalized. */
  file: string;
  status: GitFileStatus;
}

export interface GitChangeSet {
  files: GitChangedFile[];
  warnings: string[];
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function validateGitBase(base: string | undefined): string {
  const normalized = (base ?? DEFAULT_BASE).trim();
  if (!normalized) {
    throw new Error("Git base must not be empty.");
  }
  if (!SAFE_GIT_REF.test(normalized) || normalized.includes("..") || normalized.includes("@{") || normalized.includes("//") || normalized.startsWith("-")) {
    throw new Error(`Unsafe git base ref: ${base ?? ""}`);
  }
  return normalized;
}

function statusFromLetter(letter: string): GitFileStatus {
  switch (letter.charAt(0)) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "T": return "type_changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

async function git(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: workspaceRoot, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/**
 * Files changed between `base` and the working tree (`git diff --name-status --no-renames
 * --relative`), plus untracked, non-ignored files (`git ls-files --others --exclude-standard`).
 * Paths are relative to `workspaceRoot` even when it is a subdirectory of the repository.
 * Throws when git fails (not a repository, unknown base); callers turn that into a warning.
 */
export async function gitChangedFileEntries(workspaceRoot: string, base?: string, options: { includeUntracked?: boolean } = {}): Promise<GitChangeSet> {
  const safeBase = validateGitBase(base);
  const warnings: string[] = [];
  const byFile = new Map<string, GitChangedFile>();
  const diff = await git(workspaceRoot, ["diff", "--name-status", "--no-renames", "--relative", "-z", safeBase, "--"]);
  const parts = diff.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const letter = parts[index]?.trim() ?? "";
    const file = normalizeSlashes(parts[index + 1]?.trim() ?? "");
    if (!letter || !file) continue;
    byFile.set(file, { file, status: statusFromLetter(letter) });
  }
  if (options.includeUntracked !== false) {
    try {
      const untracked = (await git(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"])).split("\0").map((file) => normalizeSlashes(file.trim())).filter(Boolean);
      if (untracked.length > MAX_UNTRACKED_FILES) {
        warnings.push(`Found ${untracked.length} untracked files; only the first ${MAX_UNTRACKED_FILES} are analyzed. Add large untracked trees (for example bitrix/) to .gitignore.`);
      }
      for (const file of untracked.sort((a, b) => a.localeCompare(b)).slice(0, MAX_UNTRACKED_FILES)) {
        if (!byFile.has(file)) byFile.set(file, { file, status: "untracked" });
      }
    } catch (error) {
      warnings.push(`Unable to list untracked files: ${gitErrorMessage(error)}`);
    }
  }
  return { files: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)), warnings };
}

/** Content of `file` (workspace-relative) at `base`, or undefined when it does not exist there. */
export async function gitShowFileAtBase(workspaceRoot: string, base: string, file: string): Promise<string | undefined> {
  const safeBase = validateGitBase(base);
  try {
    return await git(workspaceRoot, ["show", `${safeBase}:./${normalizeSlashes(file).replace(/^\.\//u, "")}`]);
  } catch {
    return undefined;
  }
}

export function gitErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ");
}

export function gitUnavailableWarning(error: unknown, base: string): string {
  return `Unable to read git changes for base ${base}; returning an empty change set. ${gitErrorMessage(error)}`;
}
