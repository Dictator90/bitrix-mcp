import path from "node:path";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".php": "php",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".json": "json",
  ".md": "markdown",
  ".txt": "text"
};

export function detectLanguage(filePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "text";
}
