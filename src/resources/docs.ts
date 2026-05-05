import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { DocResource } from "../types.js";

export async function listDocResources(docsDir: string): Promise<DocResource[]> {
  const root = path.resolve(docsDir);
  const files = await fg(["**/*.{md,txt}"], { cwd: root, onlyFiles: true, dot: false }).catch(() => [] as string[]);
  return files.sort().map((relativePath) => {
    const name = relativePath.replace(/\.(md|txt)$/i, "").replace(/[\\/]/g, " / ");
    return {
      uri: `bitrix-docs://${relativePath}`,
      name,
      description: `Bitrix Framework documentation: ${name}`,
      mimeType: relativePath.endsWith(".md") ? "text/markdown" : "text/plain",
      path: path.join(root, relativePath)
    };
  });
}

export async function readDocResource(docsDir: string, uri: string): Promise<{ contents: string; resource: DocResource }> {
  const resources = await listDocResources(docsDir);
  const resource = resources.find((entry) => entry.uri === uri);
  if (!resource) {
    throw new Error(`Unknown documentation resource: ${uri}`);
  }
  return { contents: await fs.readFile(resource.path, "utf8"), resource };
}
