import fs from "node:fs/promises";
import path from "node:path";

const BITRIX_JS_EXTENSIONS = "{js,jsx,ts,tsx}";

/** A specific list of Bitrix core modules, or every module. */
export type BitrixModuleSelection = string[] | "all";

export interface BitrixIndexSelection {
  /** Which `bitrix/modules/*` to index. Defaults to "all". */
  modules: BitrixModuleSelection;
  /** Index per-module `lang` message files. Defaults to false. */
  includeLang: boolean;
}

export interface ResolvedBitrixIndex {
  patterns: string[];
  ignores: string[];
  modules: BitrixModuleSelection;
  includeLang: boolean;
}

/** Parse a `--modules=main,iblock` / `--modules=all` value into a selection. */
export function parseModuleSelection(value: string | undefined): BitrixModuleSelection | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all" || trimmed === "*") {
    return "all";
  }
  const modules = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return modules.length > 0 ? modules : "all";
}

/**
 * Resolve the curated Bitrix core indexing config. The core allowlist is
 * module/admin/tools PHP plus core JS. Runtime, static assets, install and
 * (by default) lang message files are excluded. Components/templates are owned
 * by the template scope, so they are intentionally not included here.
 */
export function resolveBitrixIndex(selection: Partial<BitrixIndexSelection> = {}): ResolvedBitrixIndex {
  const modules = selection.modules ?? "all";
  const includeLang = selection.includeLang ?? false;

  const patterns: string[] = [];
  if (modules === "all") {
    patterns.push("bitrix/modules/**/*.php");
  } else {
    for (const module of modules) {
      patterns.push(`bitrix/modules/${module}/**/*.php`);
    }
  }
  patterns.push(
    "bitrix/admin/**/*.php",
    "bitrix/tools/**/*.php",
    `bitrix/js/**/*.${BITRIX_JS_EXTENSIONS}`,
    "local/modules/**/*.php",
    `local/js/**/*.${BITRIX_JS_EXTENSIONS}`,
  );

  const ignores = ["bitrix/modules/*/install/**", "local/modules/*/install/**"];
  if (!includeLang) {
    ignores.push("bitrix/modules/*/lang/**", "local/modules/*/lang/**");
  }

  return { patterns, ignores, modules, includeLang };
}

/** Detect the Bitrix module name from a workspace-relative path, if any. */
export function detectBitrixModule(relativePath: string): string | undefined {
  const match = relativePath
    .replace(/\\/g, "/")
    .match(/(?:^|\/)(?:bitrix|local)\/modules\/([^/]+)\//);
  return match?.[1];
}

/**
 * Check which requested modules actually exist under `<root>/bitrix/modules`.
 * Used to warn about typos without failing the whole run.
 */
export async function validateBitrixModules(root: string, modules: BitrixModuleSelection): Promise<{ found: string[]; missing: string[] }> {
  if (modules === "all") {
    return { found: [], missing: [] };
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const module of modules) {
    const candidates = [path.join(root, "bitrix", "modules", module), path.join(root, "local", "modules", module)];
    let exists = false;
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isDirectory()) {
          exists = true;
          break;
        }
      } catch {
        // not present in this location
      }
    }
    (exists ? found : missing).push(module);
  }
  return { found, missing };
}
