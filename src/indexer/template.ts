import path from "node:path";
import { DEFAULT_INDEX_PATTERNS } from "./indexer.js";

export interface TemplateIndexTarget {
  root: string;
  patterns?: string[];
}

export function resolveTemplateIndexTarget(workspaceRoot: string, templatePath?: string): TemplateIndexTarget {
  if (!templatePath) {
    return { root: workspaceRoot };
  }

  return {
    root: path.resolve(workspaceRoot, templatePath),
    patterns: DEFAULT_INDEX_PATTERNS
  };
}
