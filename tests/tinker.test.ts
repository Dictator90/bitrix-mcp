import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { runTinker } from "../src/php/tinker.js";
import type { RuntimePaths } from "../src/config/paths.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

function runtimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  return {
    workspaceRoot: fixtureRoot,
    dataDir: path.join(os.tmpdir(), "bitrix-mcp-tinker-test-data"),
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php",
    ...overrides
  };
}

function registeredTools(paths: RuntimePaths): Record<string, unknown> {
  const server = createMcpServer(paths);
  return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

test("bitrix_tinker is not registered when tinkerEnabled is false", () => {
  const tools = registeredTools(runtimePaths({ tinkerEnabled: false }));
  assert.equal("bitrix_tinker" in tools, false);
});

test("bitrix_tinker registers when tinkerEnabled is true", () => {
  const tools = registeredTools(runtimePaths({ tinkerEnabled: true }));
  assert.equal("bitrix_tinker" in tools, true);
});

test("runTinker returns a config error when bitrixRoot is unknown", async () => {
  const result = await runTinker(runtimePaths({ tinkerEnabled: true, bitrixRoot: undefined }), "return 1;");
  assert.equal(result.ok, false);
  assert.equal(result.error?.type, "ConfigError");
});
