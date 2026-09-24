/**
 * Silences Node's one-time `ExperimentalWarning: SQLite is an experimental
 * feature` notice. The warning is emitted when `node:sqlite` is first loaded,
 * which happens while the static import graph is linked — so this module must
 * be imported by an entry point that loads the rest of the program with a
 * dynamic `import()` afterwards. Every other warning is passed through.
 */
const originalEmitWarning = process.emitWarning;

function warningType(args: unknown[]): string | undefined {
  const [typeOrOptions] = args;
  if (typeof typeOrOptions === "string") return typeOrOptions;
  if (typeOrOptions && typeof typeOrOptions === "object" && "type" in typeOrOptions) {
    const type = (typeOrOptions as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

export function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const type = warning instanceof Error ? warning.name : warningType(args);
  const message = warning instanceof Error ? warning.message : warning;
  return type === "ExperimentalWarning" && /\bSQLite\b/u.test(message);
}

process.emitWarning = function emitWarning(this: NodeJS.Process, warning: string | Error, ...args: unknown[]): void {
  if (isSqliteExperimentalWarning(warning, args)) return;
  (originalEmitWarning as (...params: unknown[]) => void).call(this, warning, ...args);
} as typeof process.emitWarning;
