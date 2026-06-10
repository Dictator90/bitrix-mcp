import { CompactProgressReporter } from "./compactReporter.js";
import { JsonProgressReporter, type ProgressStream } from "./jsonReporter.js";
import { NoopProgressReporter } from "./noopReporter.js";
import { TtyProgressReporter } from "./ttyReporter.js";
import type { ProgressReporter } from "./types.js";

export interface CreateProgressReporterOptions {
  /** Force progress on (true) or off (false). Undefined = auto. */
  progress?: boolean;
  /** Compact dots/checks output. */
  compact?: boolean;
  /** JSON Lines output. */
  jsonProgress?: boolean;
  /** Stream to write to (defaults to process.stderr). Never stdout. */
  stderr?: ProgressStream;
  /** Whether the target stream is an interactive TTY. */
  isTty?: boolean;
  /** Whether we are in a CI / non-interactive environment. */
  isCi?: boolean;
  /** Whether unicode marks are safe to print. */
  useUnicode?: boolean;
}

export function detectCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CI ||
      env.CONTINUOUS_INTEGRATION ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.TEAMCITY_VERSION ||
      env.TF_BUILD
  );
}

/**
 * Selects a progress reporter for an indexing run. Progress is always written
 * to stderr (never stdout), so it is safe alongside MCP stdio data.
 *
 * Rules:
 *  - `--no-progress` -> Noop
 *  - `--json-progress` -> Json
 *  - `--compact` -> Compact
 *  - interactive TTY (and not CI) -> Tty
 *  - non-TTY / CI -> Noop, unless `--progress` forces it on
 */
export function createProgressReporter(options: CreateProgressReporterOptions): ProgressReporter {
  const stream = options.stderr ?? process.stderr;
  const isTty = options.isTty ?? Boolean((stream as ProgressStream).isTTY);
  const isCi = options.isCi === true;
  const useUnicode = options.useUnicode ?? !process.env.NO_COLOR;

  if (options.progress === false) {
    return new NoopProgressReporter();
  }
  if (options.jsonProgress) {
    return new JsonProgressReporter({ stream });
  }
  if (options.compact) {
    return new CompactProgressReporter({ stream, useUnicode });
  }

  const forced = options.progress === true;
  if (!forced && (isCi || !isTty)) {
    return new NoopProgressReporter();
  }

  return new TtyProgressReporter({
    stream,
    isTty,
    useColor: useUnicode && isTty && !process.env.NO_COLOR
  });
}
