import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { assertReadOnlySql, normalizeCellValue, runQuery } from "../src/db/mysqlClient.js";
import { appendTopLevelLimit, lexSql } from "../src/db/sqlGuard.js";
import type { BitrixConnection } from "../src/db/types.js";
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

test("assertReadOnlySql accepts reads that only look dangerous inside strings, identifiers, or functions", () => {
  for (const sql of [
    "SELECT ';' AS semi, '--' AS dash, 'DELETE FROM x' AS word",
    "SELECT REPLACE(NAME, 'a', 'b'), INSERT(NAME, 1, 2, 'x') FROM b_iblock",
    "SELECT REPLACE (NAME, 'a', 'b') FROM b_iblock",
    "SELECT `update`.`ID` FROM b_iblock AS `update`",
    "SELECT t.update FROM b_iblock t",
    "SELECT * FROM b_user ORDER BY ID DESC LIMIT 5",
    "SHOW CREATE TABLE b_user",
    "SHOW GRANTS",
    "SELECT 1 -- trailing comment",
    "SELECT 1 # hash comment",
    "SELECT 1 /* block comment */"
  ]) {
    assert.doesNotThrow(() => assertReadOnlySql(sql), `expected read-only: ${sql}`);
  }
});

test("assertReadOnlySql rejects known read-only bypasses", () => {
  const cases: Array<[string, RegExp]> = [
    ["WITH x AS (SELECT 1) DELETE FROM b_user WHERE ID > 1", /DELETE/],
    ["WITH x AS (SELECT 1) UPDATE b_user SET LOGIN = 'x'", /UPDATE/],
    ["SELECT '<?php' INTO OUTFILE '/var/www/upload/x.php'", /INTO/],
    ["SELECT 'x' INTO DUMPFILE '/tmp/x'", /INTO/],
    ["SELECT LOAD_FILE('/etc/passwd')", /LOAD_FILE/],
    ["SELECT load_file ('/etc/passwd')", /LOAD_FILE/],
    ["SELECT SLEEP(100)", /SLEEP/],
    ["SELECT BENCHMARK(1e10, SHA2('a', 512))", /BENCHMARK/],
    ["SELECT GET_LOCK('x', 10)", /GET_LOCK/],
    ["SELECT * FROM b_user FOR UPDATE", /UPDATE/],
    ["SELECT * FROM b_user LOCK IN SHARE MODE", /LOCK/],
    ["SELECT 1 INTO @x", /INTO/],
    ["SELECT /*!50000 1; DELETE FROM b_user */", /executable comments/],
    ["SELECT /*M!100000 1 */", /executable comments/],
    ["SELECT '--'; DROP TABLE t", /single SQL statement/],
    ["SHOW TABLES WHERE SLEEP(5)", /SLEEP/],
    ["EXPLAIN ANALYZE DELETE FROM b_user", /DELETE/],
    ["SELECT 'unterminated", /unterminated/]
  ];
  for (const [sql, message] of cases) {
    assert.throws(() => assertReadOnlySql(sql), message, `expected rejection: ${sql}`);
  }
});

test("appendTopLevelLimit ignores nested LIMITs and cannot be swallowed by a trailing comment", () => {
  const sql = "SELECT * FROM b_user WHERE ID IN (SELECT ID FROM b_user LIMIT 3) -- note";
  assert.equal(appendTopLevelLimit(sql, lexSql(sql).tokens, 11), "SELECT * FROM b_user WHERE ID IN (SELECT ID FROM b_user LIMIT 3) LIMIT 11");
  const limited = "SELECT * FROM b_user LIMIT 5;";
  assert.equal(appendTopLevelLimit(limited, lexSql(limited).tokens, 11), undefined);
  assert.equal(appendTopLevelLimit("SHOW TABLES", lexSql("SHOW TABLES").tokens, 11), undefined);
});

test("normalizeCellValue renders BLOBs, bigints and long strings compactly", () => {
  assert.equal(normalizeCellValue(Buffer.from("a:1:{s:1:\"x\";}")), "a:1:{s:1:\"x\";}");
  assert.match(String(normalizeCellValue(Buffer.from([0, 1, 2, 255]))), /^<binary 4 bytes: 000102ff>$/);
  assert.equal(normalizeCellValue(9007199254740993n), "9007199254740993");
  assert.match(String(normalizeCellValue("x".repeat(5000))), /… \[truncated, 5000 chars\]$/);
  assert.equal(normalizeCellValue(null), null);
});

// Live checks against a real MySQL/MariaDB. Opt-in: set BITRIX_MCP_TEST_MYSQL to
// JSON like {"host":"127.0.0.1","port":3306,"database":"bx","login":"u","password":"p"}.
const liveMysql = process.env.BITRIX_MCP_TEST_MYSQL;
const liveSkip = liveMysql ? false : "set BITRIX_MCP_TEST_MYSQL to run against a live MySQL/MariaDB";

function liveConnection(): BitrixConnection {
  return { name: "default", ...(JSON.parse(liveMysql ?? "{}") as Omit<BitrixConnection, "name">) };
}

test("runQuery streams at most rowLimit rows and keeps BIGINT precision (live)", { skip: liveSkip }, async () => {
  const result = await runQuery(liveConnection(), "SELECT 9007199254740993 AS big UNION ALL SELECT 2 UNION ALL SELECT 3 -- comment", { readOnly: true, rowLimit: 2 });
  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedReason, "rows");
  assert.equal(result.rows[0]?.big, "9007199254740993");
});

test("runQuery enforces the byte budget (live)", { skip: liveSkip }, async () => {
  const result = await runQuery(liveConnection(), "SELECT REPEAT('x', 3000) AS v UNION ALL SELECT REPEAT('y', 3000) UNION ALL SELECT REPEAT('z', 3000)", { readOnly: true, rowLimit: 100, maxBytes: 5000 });
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncatedReason, "bytes");
});

test("runQuery cancels long statements on the server (live)", { skip: liveSkip }, async () => {
  const started = Date.now();
  await assert.rejects(
    runQuery(liveConnection(), "SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c", { readOnly: true, timeoutMs: 1500 }),
    /timeout|interrupted|max_statement_time|maximum statement execution time/i
  );
  assert.ok(Date.now() - started < 10_000);
});
