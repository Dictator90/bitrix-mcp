import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

/** Reads the package version from package.json (works from src/ via tsx and from dist/). */
export function readPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
