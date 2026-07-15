/**
 * Shared type contracts for the Bitrix tinker feature: running arbitrary PHP
 * with the Bitrix kernel bootstrapped and capturing the result.
 */

/**
 * A captured PHP error (thrown exception or fatal shutdown error).
 */
export interface TinkerError {
  type: string;
  message: string;
  file?: string;
  line?: number;
}

/**
 * Result of executing a PHP snippet through the bootstrapped Bitrix runtime.
 * `returnValue` holds the JSON-encodable value returned by the snippet (via a
 * top-level `return`); `returnText` is a printable fallback for values that do
 * not survive JSON encoding. `output` collects anything the snippet echoed.
 */
export interface TinkerResult {
  ok: boolean;
  returnValue?: unknown;
  returnText?: string;
  output: string;
  error?: TinkerError;
  durationMs?: number;
}
