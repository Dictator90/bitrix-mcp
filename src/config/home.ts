import os from "node:os";
import path from "node:path";

/**
 * Home directory used for global MCP client configs (Windsurf, Cline, Codex,
 * Kilo Code). `BITRIX_MCP_HOME_DIR` overrides it so tests and sandboxes never
 * touch the real home directory.
 */
export function resolveHomeDir(): string {
  const override = process.env.BITRIX_MCP_HOME_DIR?.trim();
  return override ? path.resolve(override) : os.homedir();
}
