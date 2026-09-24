import ignore from "ignore";

/**
 * Files that hold credentials or bulk data and must never be returned to an
 * AI client or indexed: Bitrix DB settings, license key, env/VCS/SSH files,
 * dumps and backups. Gitignore syntax, matched case-insensitively against
 * slash-normalized workspace-relative paths.
 */
export const SECRET_FILE_PATTERNS = [
  ".settings.php",
  ".settings_extra.php",
  "**/php_interface/dbconn.php",
  "**/bitrix/license_key.php",
  ".env",
  ".env.*",
  ".git/",
  ".svn/",
  ".hg/",
  ".ssh/",
  ".htpasswd",
  ".npmrc",
  "auth.json",
  "id_rsa*",
  "id_ed25519*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.sql",
  "*.sql.gz",
  "*.sqlite",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "**/bitrix/backup/"
];

export const ALLOW_SECRET_FILES_ENV = "BITRIX_MCP_ALLOW_SECRET_FILES";

const matcher = ignore({ ignorecase: true }).add(SECRET_FILE_PATTERNS);

/** True when `relativePath` (relative to the workspace or data dir) matches {@link SECRET_FILE_PATTERNS}. */
export function isSecretFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("../")) return false;
  return matcher.ignores(normalized);
}

/** Secret filtering can be disabled explicitly for trusted local debugging. */
export function secretFilesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_SECRET_FILES_ENV] === "1";
}
