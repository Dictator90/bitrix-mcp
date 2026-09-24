import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { buildTinkerEnv, runTinker } from "../src/php/tinker.js";
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


function phpAvailable(): boolean {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const phpSkip = phpAvailable() ? false : "php CLI not available";

async function withStubKernel(run: (paths: RuntimePaths) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-tinker-root-"));
  try {
    await fs.mkdir(path.join(root, "bitrix/modules/main/include"), { recursive: true });
    await fs.writeFile(path.join(root, "bitrix/modules/main/include/prolog_before.php"), "<?php\nob_start();\necho 'kernel-noise';\n", "utf8");
    await run(runtimePaths({ tinkerEnabled: true, bitrixRoot: root }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("buildTinkerEnv passes only allowlisted variables", () => {
  const env = buildTinkerEnv({ PATH: "/bin", OPENAI_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y", MY_VAR: "z", BITRIX_MCP_TINKER_ENV_PASSTHROUGH: "MY_VAR" }, { BX_MCP_DOCROOT: "/site" });
  assert.deepEqual(env, { PATH: "/bin", MY_VAR: "z", BX_MCP_DOCROOT: "/site" });
});

test("runTinker returns values and output, hides the parent environment, and reports exit()", { skip: phpSkip }, async () => {
  await withStubKernel(async (paths) => {
    const ok = await runTinker(paths, "echo 'hi'; return ['a' => 1];");
    assert.equal(ok.ok, true);
    assert.equal(ok.output, "hi");
    assert.deepEqual(ok.returnValue, { a: 1 });

    process.env.BITRIX_MCP_TEST_SECRET = "leak";
    try {
      const env = await runTinker(paths, "return getenv('BITRIX_MCP_TEST_SECRET') ?: 'hidden';");
      assert.equal(env.returnValue, "hidden");
    } finally {
      delete process.env.BITRIX_MCP_TEST_SECRET;
    }

    const exited = await runTinker(paths, "echo 'bye'; exit;");
    assert.equal(exited.ok, true);
    assert.equal(exited.exited, true);
    assert.equal(exited.output, "bye");

    const big = await runTinker(paths, "return str_repeat('x', 20000);");
    assert.equal(big.returnValue, undefined);
    assert.match(big.returnText ?? "", /truncated/);
  });
});

test("runTinker kills PHP on timeout", { skip: phpSkip }, async () => {
  await withStubKernel(async (paths) => {
    const started = Date.now();
    const result = await runTinker(paths, "sleep(30);", { timeoutMs: 1000 });
    assert.equal(result.error?.type, "Timeout");
    assert.ok(Date.now() - started < 5000);
  });
});
