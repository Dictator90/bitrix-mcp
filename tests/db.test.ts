import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { assertReadOnlySql } from "../src/db/mysqlClient.js";
import type { RuntimePaths } from "../src/config/paths.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

function runtimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  return {
    workspaceRoot: fixtureRoot,
    dataDir: path.join(os.tmpdir(), "bitrix-mcp-db-test-data"),
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

test("DB tools are not registered when dbEnabled is false", () => {
  const tools = registeredTools(runtimePaths({ dbEnabled: false, dbAllowWrite: false }));
  assert.equal("bitrix_db_connections" in tools, false);
  assert.equal("bitrix_db_schema" in tools, false);
  assert.equal("bitrix_db_query" in tools, false);
  assert.equal("bitrix_db_execute" in tools, false);
});

test("read DB tools register when dbEnabled, but execute stays gated by dbAllowWrite", () => {
  const tools = registeredTools(runtimePaths({ dbEnabled: true, dbAllowWrite: false }));
  assert.equal("bitrix_db_connections" in tools, true);
  assert.equal("bitrix_db_schema" in tools, true);
  assert.equal("bitrix_db_query" in tools, true);
  assert.equal("bitrix_db_execute" in tools, false);
});

test("bitrix_db_execute registers only when dbAllowWrite is true", () => {
  const tools = registeredTools(runtimePaths({ dbEnabled: true, dbAllowWrite: true }));
  assert.equal("bitrix_db_execute" in tools, true);
});

test("assertReadOnlySql accepts read statements", () => {
  for (const sql of [
    "SELECT * FROM b_iblock",
    "  select id from b_user ",
    "SHOW TABLES",
    "EXPLAIN SELECT 1",
    "DESCRIBE b_iblock",
    "WITH t AS (SELECT 1) SELECT * FROM t",
    "SELECT 1;"
  ]) {
    assert.doesNotThrow(() => assertReadOnlySql(sql), `expected read-only: ${sql}`);
  }
});

test("assertReadOnlySql rejects writes and stacked statements", () => {
  for (const sql of [
    "INSERT INTO b_user (ID) VALUES (1)",
    "UPDATE b_iblock SET NAME = 'x'",
    "DELETE FROM b_iblock",
    "DROP TABLE b_iblock",
    "TRUNCATE b_iblock",
    "SELECT 1; DROP TABLE b_iblock"
  ]) {
    assert.throws(() => assertReadOnlySql(sql), `expected rejection: ${sql}`);
  }
});
