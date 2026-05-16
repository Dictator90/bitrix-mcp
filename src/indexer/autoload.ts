import fs from "node:fs/promises";
import path from "node:path";
import { writeAutoloadRecords } from "./sqliteStore.js";
import type { AutoloadRecord, BitrixRelationRecord } from "../types.js";

const BOOTSTRAP_FILES = [
  "local/php_interface/init.php",
  "bitrix/php_interface/init.php",
  "bitrix/.settings.php",
  "local/.settings.php"
];

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [normalizeRelativePath(value)];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string").map(normalizeRelativePath);
  return [];
}

function dependencyRecords(dependencies: unknown, type: "dependency" | "dev_dependency", sourceFile: string, root: string): AutoloadRecord[] {
  return objectEntries(dependencies).map(([packageName, version]) => ({
    type,
    package: packageName,
    version: typeof version === "string" ? version : JSON.stringify(version),
    sourceFile,
    root,
    dev: type === "dev_dependency"
  }));
}

function relationForRecord(record: AutoloadRecord): BitrixRelationRecord[] {
  if (record.type === "psr-4" && record.namespace) {
    return (record.paths ?? []).map((autoloadPath) => ({
      sourceType: "namespace_prefix",
      sourceName: record.namespace ?? "",
      targetType: "directory",
      targetName: autoloadPath,
      relationType: "autoloads_from",
      file: record.sourceFile,
      line: 1,
      kind: "autoload",
      metadata: { sourceFile: record.sourceFile }
    }));
  }
  if ((record.type === "dependency" || record.type === "dev_dependency") && record.package) {
    return [{
      sourceType: "package",
      sourceName: record.package,
      targetType: record.type,
      targetName: record.version ?? record.package,
      relationType: "is_dependency",
      file: record.sourceFile,
      line: 1,
      kind: "autoload",
      metadata: { dev: record.dev }
    }];
  }
  if (record.type === "bootstrap" && record.file) {
    return [{
      sourceType: "file",
      sourceName: record.file,
      targetType: "bootstrap",
      targetName: record.file,
      relationType: "is_bootstrap",
      file: path.join(record.root, record.file),
      line: 1,
      kind: "autoload"
    }];
  }
  return [];
}

export async function indexAutoloadMetadata(root: string, dbFile: string): Promise<{ records: number; relations: number }> {
  const resolvedRoot = path.resolve(root);
  const records: AutoloadRecord[] = [];
  const composerRelative = "composer.json";
  const composerFile = path.join(resolvedRoot, composerRelative);

  if (await fileExists(composerFile)) {
    const composer = JSON.parse(await fs.readFile(composerFile, "utf8")) as Record<string, unknown>;
    const autoload = composer.autoload && typeof composer.autoload === "object" ? composer.autoload as Record<string, unknown> : {};
    const autoloadDev = composer["autoload-dev"] && typeof composer["autoload-dev"] === "object" ? composer["autoload-dev"] as Record<string, unknown> : {};

    for (const [namespace, value] of objectEntries(autoload["psr-4"])) {
      records.push({ type: "psr-4", namespace, paths: stringArray(value), sourceFile: composerRelative, root: resolvedRoot });
    }
    for (const [namespace, value] of objectEntries(autoloadDev["psr-4"])) {
      records.push({ type: "psr-4", namespace, paths: stringArray(value), sourceFile: composerRelative, root: resolvedRoot, dev: true, metadata: { section: "autoload-dev" } });
    }
    for (const file of stringArray(autoload.files)) {
      records.push({ type: "files", file, sourceFile: composerRelative, root: resolvedRoot });
    }
    for (const classmapPath of stringArray(autoload.classmap)) {
      records.push({ type: "classmap", file: classmapPath, paths: [classmapPath], sourceFile: composerRelative, root: resolvedRoot });
    }
    records.push(...dependencyRecords(composer.require, "dependency", composerRelative, resolvedRoot));
    records.push(...dependencyRecords(composer["require-dev"], "dev_dependency", composerRelative, resolvedRoot));
  }

  for (const bootstrapFile of BOOTSTRAP_FILES) {
    if (await fileExists(path.join(resolvedRoot, bootstrapFile))) {
      records.push({ type: "bootstrap", file: bootstrapFile, sourceFile: bootstrapFile, root: resolvedRoot });
    }
  }

  const relations = records.flatMap(relationForRecord);
  await writeAutoloadRecords(dbFile, records, relations);
  return { records: records.length, relations: relations.length };
}
