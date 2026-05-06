import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimePaths } from "../src/config/paths.js";

function withBitrixRootEnv<T>(value: string | undefined, callback: () => T): T {
  const previous = process.env.BITRIX_ROOT;
  if (value === undefined) {
    delete process.env.BITRIX_ROOT;
  } else {
    process.env.BITRIX_ROOT = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_ROOT;
    } else {
      process.env.BITRIX_ROOT = previous;
    }
  }
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bitrix-mcp-paths-"));
}

test("resolveRuntimePaths uses explicit BITRIX_ROOT", () => {
  const workspaceRoot = tempWorkspace();
  const explicitRoot = path.join(workspaceRoot, "explicit-site");
  fs.mkdirSync(path.join(workspaceRoot, "bitrix"));

  withBitrixRootEnv(explicitRoot, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, explicitRoot);
  });
});

test("resolveRuntimePaths uses workspace root when workspace bitrix directory exists", () => {
  const workspaceRoot = tempWorkspace();
  fs.mkdirSync(path.join(workspaceRoot, "bitrix"));

  withBitrixRootEnv(undefined, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, workspaceRoot);
  });
});

test("resolveRuntimePaths leaves bitrixRoot unset when no workspace bitrix directory exists", () => {
  const workspaceRoot = tempWorkspace();

  withBitrixRootEnv(undefined, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, undefined);
  });
});
