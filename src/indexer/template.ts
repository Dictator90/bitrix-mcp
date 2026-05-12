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


export const COMPONENT_RELATED_FILENAMES = new Set([
  "class.php",
  "component.php",
  "template.php",
  "result_modifier.php",
  "component_epilog.php",
  ".parameters.php",
  ".description.php",
  "script.js",
  "style.css"
]);

export function componentFilesystemParts(component: string): { vendor: string; name: string; componentPath: string } | undefined {
  const [vendor, name] = component.split(":");
  if (!vendor || !name) return undefined;
  return { vendor, name, componentPath: `${vendor}/${name}` };
}

export function possibleComponentTemplateRelativePaths(component: string, template = ".default", site = "<site>"): string[] {
  const parts = componentFilesystemParts(component);
  if (!parts) return [];
  const normalizedTemplate = template && template.trim() ? template : ".default";
  return [
    `local/templates/${site}/components/${parts.componentPath}/${normalizedTemplate}`,
    `bitrix/templates/${site}/components/${parts.componentPath}/${normalizedTemplate}`,
    `local/components/${parts.componentPath}/templates/${normalizedTemplate}`,
    `bitrix/components/${parts.componentPath}/templates/${normalizedTemplate}`
  ];
}

export function componentNameFromRelativePath(relativePath: string): { component: string; template?: string; role: "template" | "source" | "asset" } | undefined {
  const normalized = relativePath.replace(/\\/gu, "/");
  const siteTemplate = normalized.match(/^(?:local|bitrix)\/templates\/[^/]+\/components\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/u);
  if (siteTemplate) {
    const basename = siteTemplate[4].split("/").at(-1) ?? "";
    return {
      component: `${siteTemplate[1]}:${siteTemplate[2]}`,
      template: siteTemplate[3],
      role: ["script.js", "style.css"].includes(basename) ? "asset" : "template"
    };
  }
  const componentTemplate = normalized.match(/^(?:local|bitrix)\/components\/([^/]+)\/([^/]+)\/templates\/([^/]+)\/(.+)$/u);
  if (componentTemplate) {
    const basename = componentTemplate[4].split("/").at(-1) ?? "";
    return {
      component: `${componentTemplate[1]}:${componentTemplate[2]}`,
      template: componentTemplate[3],
      role: ["script.js", "style.css"].includes(basename) ? "asset" : "template"
    };
  }
  const componentSource = normalized.match(/^(?:local|bitrix)\/components\/([^/]+)\/([^/]+)\/(.+)$/u);
  if (componentSource) {
    const basename = componentSource[3].split("/").at(-1) ?? "";
    if (COMPONENT_RELATED_FILENAMES.has(basename)) {
      return { component: `${componentSource[1]}:${componentSource[2]}`, role: ["script.js", "style.css"].includes(basename) ? "asset" : "source" };
    }
  }
  return undefined;
}
