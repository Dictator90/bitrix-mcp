import path from "node:path";
import { indexPath, type RuntimePaths } from "../config/paths.js";
import { DEFAULT_INDEX_PATTERNS, type IndexOptions } from "./indexer.js";

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

export function resolveTemplateIndexOptions(paths: RuntimePaths, templatePath?: string): IndexOptions {
  const target = resolveTemplateIndexTarget(paths.workspaceRoot, templatePath);
  return {
    root: target.root,
    kind: "template",
    outFile: indexPath(paths.dataDir, "template"),
    patterns: target.patterns
  };
}
