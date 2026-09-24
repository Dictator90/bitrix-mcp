import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimePaths } from "../config/paths.js";
import type { TinkerError, TinkerResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30000;
const TEMP_DIR_PREFIX = "bitrix-mcp-tinker-";
const RETURN_TEXT_MAX_LENGTH = 8192;
/** A JSON `returnValue` larger than this is dropped; `returnText` (truncated var_export) still describes it. */
const RETURN_VALUE_MAX_JSON_CHARS = 8192;
/** Echoed output kept in the result. */
const OUTPUT_MAX_CHARS = 20_000;
/** Hard cap on captured stdout+stderr; the PHP process is killed when exceeded. */
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * Environment variables passed through to PHP. Everything else in the MCP
 * client's environment (API tokens, cloud credentials, …) is withheld.
 * Extend with BITRIX_MCP_TINKER_ENV_PASSTHROUGH=VAR1,VAR2.
 */
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "PHPRC", "PHP_INI_SCAN_DIR",
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"
];

/** Builds the minimal environment for the PHP child process. */
export function buildTinkerEnv(source: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const names = new Set(PASSTHROUGH_ENV);
  for (const name of (source.BITRIX_MCP_TINKER_ENV_PASSTHROUGH ?? "").split(",")) {
    if (name.trim()) names.add(name.trim());
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return { ...env, ...extra };
}

/**
 * Matches a leading UTF-8 BOM and/or an opening `<?php` or short `<?` tag at
 * the very start of a PHP snippet, so it can be stripped before the snippet
 * is re-wrapped in its own `<?php` tag.
 */
const OPENING_PHP_TAG_PATTERN = new RegExp("^\\uFEFF?\\s*<\\?(?:php\\b)?\\s?", "i");

export interface RunTinkerOptions {
  timeoutMs?: number;
}

interface PhpExecution {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

/**
 * Removes a leading `<?php` / `<?` opening tag (and BOM, if present) from
 * `code`, so callers can safely prefix it with a single `<?php` tag without
 * producing a duplicate/invalid opening sequence.
 */
function stripOpeningPhpTag(code: string): string {
  return code.replace(OPENING_PHP_TAG_PATTERN, "");
}

/**
 * Derives a sentinel string that marks the boundary between PHP kernel
 * bootstrap/user-code noise (stdout before it) and the JSON result payload
 * (stdout after it). Built from the temp directory's basename, which
 * `fs.mkdtemp` already randomizes, so no separate randomness source is
 * needed here.
 */
function buildSentinel(tempDirName: string): string {
  return `__BITRIX_MCP_TINKER_RESULT__${tempDirName}__`;
}

/**
 * Generates the PHP bootstrap/capture script executed by the CLI. It
 * bootstraps the Bitrix kernel via `prolog_before.php`, runs the user's code
 * file under output buffering, and emits exactly one JSON result payload
 * (success, thrown exception, or fatal error) preceded by `sentinel` on its
 * own line. A shutdown-function guard ensures fatal errors — which bypass
 * try/catch entirely — still produce a result instead of silent truncation.
 */
function buildRunnerScript(sentinel: string): string {
  return `<?php

$__bxMcpEmitted = false;
$__bxMcpEmit = function (array $payload) use (&$__bxMcpEmitted): void {
    if ($__bxMcpEmitted) {
        return;
    }
    $__bxMcpEmitted = true;
    echo "\\n" . '${sentinel}' . "\\n";
    $__bxMcpJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($__bxMcpJson === false) {
        $__bxMcpJson = json_encode([
            'ok' => false,
            'output' => '',
            'error' => [
                'type' => 'EncodingError',
                'message' => 'Failed to JSON-encode the tinker result payload.'
            ]
        ]);
    }
    echo $__bxMcpJson;
};

register_shutdown_function(function () use (&$__bxMcpEmitted, $__bxMcpEmit): void {
    if ($__bxMcpEmitted) {
        return;
    }
    $__bxMcpLastError = error_get_last();
    $__bxMcpFatalMask = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR;
    $__bxMcpBuffered = '';
    $__bxMcpBaseLevel = $GLOBALS['__bxMcpBaseLevel'] ?? 0;
    while (ob_get_level() > $__bxMcpBaseLevel) {
        $__bxMcpBuffered = (string) ob_get_clean() . $__bxMcpBuffered;
    }
    if ($__bxMcpLastError !== null && ($__bxMcpLastError['type'] & $__bxMcpFatalMask) !== 0) {
        $__bxMcpEmit([
            'ok' => false,
            'output' => $__bxMcpBuffered,
            'error' => [
                'type' => 'FatalError',
                'message' => $__bxMcpLastError['message'],
                'file' => $__bxMcpLastError['file'],
                'line' => $__bxMcpLastError['line']
            ]
        ]);
        return;
    }
    // The snippet (or code it called) ran exit()/die(): report its output instead of "no output".
    $__bxMcpEmit([
        'ok' => true,
        'output' => $__bxMcpBuffered,
        'exited' => true
    ]);
});

$_SERVER['DOCUMENT_ROOT'] = getenv('BX_MCP_DOCROOT');

define('NO_KEEP_STATISTIC', true);
define('NOT_CHECK_PERMISSIONS', true);
define('STOP_STATISTICS', true);
define('BX_NO_ACCELERATOR_RESET', true);
define('CHK_EVENT', false);

require $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';

$GLOBALS['__bxMcpBaseLevel'] = ob_get_level();
ob_start();
try {
    $__bxMcpReturn = include getenv('BX_MCP_CODE_FILE');
    $__bxMcpOutput = ob_get_clean();

    $__bxMcpPayload = [
        'ok' => true,
        'output' => $__bxMcpOutput
    ];

    $__bxMcpReturnJson = json_encode($__bxMcpReturn, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($__bxMcpReturnJson !== false && strlen($__bxMcpReturnJson) <= ${RETURN_VALUE_MAX_JSON_CHARS}) {
        $__bxMcpPayload['returnValue'] = $__bxMcpReturn;
    }

    $__bxMcpReturnText = var_export($__bxMcpReturn, true);
    if (strlen($__bxMcpReturnText) > ${RETURN_TEXT_MAX_LENGTH}) {
        $__bxMcpReturnText = substr($__bxMcpReturnText, 0, ${RETURN_TEXT_MAX_LENGTH}) . "\\n...[truncated]";
    }
    $__bxMcpPayload['returnText'] = $__bxMcpReturnText;

    $__bxMcpEmit($__bxMcpPayload);
} catch (\\Throwable $__bxMcpException) {
    $__bxMcpOutput = ob_get_clean();
    $__bxMcpEmit([
        'ok' => false,
        'output' => $__bxMcpOutput,
        'error' => [
            'type' => get_class($__bxMcpException),
            'message' => $__bxMcpException->getMessage(),
            'file' => $__bxMcpException->getFile(),
            'line' => $__bxMcpException->getLine()
        ]
    ]);
}
`;
}

function buildPhpArgs(runnerPath: string): string[] {
  return ["-d", "display_errors=0", "-d", "log_errors=0", "-d", "memory_limit=512M", runnerPath];
}

/**
 * Spawns `phpBin` against `runnerPath`. On Windows, `phpBin` may be a
 * `.bat`/`.cmd` shim (e.g. a Herd/Laragon install) that `child_process.spawn`
 * cannot execute directly without a shell, so the call is routed through
 * `cmd /c` there, mirroring the precedent in `src/init/init.ts`
 * (`serverInvocation()`). Elsewhere, `phpBin` is spawned directly.
 */
function spawnPhp(phpBin: string, runnerPath: string, env: NodeJS.ProcessEnv) {
  const args = buildPhpArgs(runnerPath);
  return process.platform === "win32"
    ? spawn("cmd", ["/c", phpBin, ...args], { env, windowsHide: true })
    : spawn(phpBin, args, { env, detached: true });
}

/**
 * Terminates the PHP process and anything it started: the whole process
 * group on POSIX (SIGTERM, then SIGKILL after a grace period), and the process
 * tree via `taskkill /T /F` on Windows, where PHP may run behind `cmd /c`.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      child.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL");
  }, KILL_GRACE_MS);
  escalation.unref?.();
}

/**
 * Runs the PHP runner as a child process, collecting stdout/stderr and
 * enforcing `timeoutMs` via a timer. Resolves as soon as the child closes, the
 * timeout fires, or captured output exceeds {@link CAPTURE_MAX_BYTES} —
 * whichever comes first — with whatever was captured up to that point; it
 * never rejects. On timeout or overflow the process tree is killed.
 */
function executePhp(phpBin: string, runnerPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<PhpExecution> {
  return new Promise((resolve) => {
    const child = spawnPhp(phpBin, runnerPath, env);
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, outputLimitExceeded });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      settle();
    }, timeoutMs);

    const capture = (chunk: Buffer, append: (text: string) => void) => {
      if (settled) return;
      capturedBytes += chunk.length;
      if (capturedBytes > CAPTURE_MAX_BYTES) {
        outputLimitExceeded = true;
        killProcessTree(child);
        settle();
        return;
      }
      append(chunk.toString("utf8"));
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, (text) => { stdout += text; }));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, (text) => { stderr += text; }));

    child.on("close", settle);
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      settle();
    });
  });
}

function truncateOutput(text: string): string {
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n...[truncated, ${text.length} chars]` : text;
}

/**
 * Splits the runner's stdout on `sentinel` and parses the JSON payload that
 * follows it into a {@link TinkerResult}. Output before the sentinel is
 * Bitrix kernel bootstrap/user-code noise and is intentionally discarded —
 * only the runner's own `output` field (captured via output buffering)
 * represents the snippet's echoed output. When no sentinel is found at all
 * (the runner crashed before emitting anything, e.g. a PHP syntax error in
 * the runner itself, or the wrong `phpBin` was configured), the raw
 * stdout/stderr is surfaced as the error message.
 */
function parseRunnerOutput(stdout: string, stderr: string, sentinel: string): TinkerResult {
  const sentinelIndex = stdout.indexOf(sentinel);
  if (sentinelIndex === -1) {
    return {
      ok: false,
      output: "",
      error: {
        type: "NoOutput",
        message: truncateOutput([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n")) || "PHP produced no output and no result sentinel."
      }
    };
  }

  const payloadText = stdout.slice(sentinelIndex + sentinel.length).trim();
  try {
    const payload = JSON.parse(payloadText) as Partial<TinkerResult>;
    return {
      ok: Boolean(payload.ok),
      output: truncateOutput(typeof payload.output === "string" ? payload.output : ""),
      returnValue: payload.returnValue,
      returnText: payload.returnText,
      ...(payload.exited ? { exited: true } : {}),
      error: payload.error as TinkerError | undefined
    };
  } catch (parseError) {
    return {
      ok: false,
      output: "",
      error: {
        type: "ParseError",
        message: `Failed to parse tinker result JSON: ${(parseError as Error).message}. Raw payload: ${payloadText.slice(0, 2000)}`
      }
    };
  }
}

/**
 * Executes `code` as PHP with the Bitrix kernel bootstrapped (via
 * `bitrix/modules/main/include/prolog_before.php`), analogous to Laravel
 * Tinker. Spawns `paths.phpBin` against a temporary runner script in a
 * fresh, isolated temp directory (always removed afterward), passing the
 * project's `bitrixRoot` as `DOCUMENT_ROOT` and the snippet as a separate
 * included file so a top-level `return <expr>;` in `code` is captured as
 * `returnValue`/`returnText`.
 *
 * Caveat inherent to PHP's `include`: when the included file has no
 * top-level `return`, `include` itself evaluates to `int(1)`, which is
 * indistinguishable from an explicit `return 1;`. `returnValue`/`returnText`
 * are reported as-is in both cases.
 *
 * Resolves (never rejects) with a {@link TinkerResult}: `ok: false` with a
 * `ConfigError` when no Bitrix root was detected, a `Timeout` error when
 * `code` runs longer than `opts.timeoutMs` (default 30000ms), or the
 * success/exception/fatal-error payload emitted by the runner otherwise.
 *
 * Temp directory cleanup is best-effort: on a timeout (see the Windows
 * caveat on {@link executePhp}), the child may still be running and
 * holding `code.php`/`runner.php` open, so an `fs.rm` cleanup failure is
 * swallowed rather than allowed to reject this otherwise-resolved call.
 */
export async function runTinker(paths: RuntimePaths, code: string, opts: RunTinkerOptions = {}): Promise<TinkerResult> {
  const startedAt = Date.now();

  if (!paths.bitrixRoot) {
    return {
      ok: false,
      output: "",
      error: {
        type: "ConfigError",
        message: "Bitrix root not detected; cannot bootstrap the kernel."
      }
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));

  try {
    const sentinel = buildSentinel(path.basename(tempDir));
    const codePath = path.join(tempDir, "code.php");
    const runnerPath = path.join(tempDir, "runner.php");

    await fs.writeFile(codePath, `<?php\n${stripOpeningPhpTag(code)}`, "utf8");
    await fs.writeFile(runnerPath, buildRunnerScript(sentinel), "utf8");

    const env = buildTinkerEnv(process.env, { BX_MCP_DOCROOT: paths.bitrixRoot, BX_MCP_CODE_FILE: codePath });

    const execution = await executePhp(paths.phpBin, runnerPath, env, timeoutMs);
    const durationMs = Date.now() - startedAt;

    if (execution.outputLimitExceeded) {
      return {
        ok: false,
        output: truncateOutput(execution.stdout),
        error: {
          type: "OutputLimit",
          message: `PHP output exceeded ${CAPTURE_MAX_BYTES} bytes; the process was killed.`
        },
        durationMs
      };
    }

    if (execution.timedOut) {
      return {
        ok: false,
        output: truncateOutput(execution.stdout),
        error: {
          type: "Timeout",
          message: `PHP execution exceeded ${timeoutMs}ms`
        },
        durationMs
      };
    }

    return { ...parseRunnerOutput(execution.stdout, execution.stderr, sentinel), durationMs };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
