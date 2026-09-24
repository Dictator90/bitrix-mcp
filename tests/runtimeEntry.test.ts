import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isSqliteExperimentalWarning } from "../src/runtime/sqliteWarning.js";
import { readPackageVersion } from "../src/config/version.js";
import { createMcpServer } from "../src/mcp/server.js";

test("isSqliteExperimentalWarning matches only the node:sqlite experimental notice", () => {
  const message = "SQLite is an experimental feature and might change at any time";
  assert.equal(isSqliteExperimentalWarning(message, ["ExperimentalWarning"]), true);
  assert.equal(isSqliteExperimentalWarning(message, [{ type: "ExperimentalWarning" }]), true);
  const error = Object.assign(new Error(message), { name: "ExperimentalWarning" });
  assert.equal(isSqliteExperimentalWarning(error, []), true);

  assert.equal(isSqliteExperimentalWarning("The Fetch API is an experimental feature", ["ExperimentalWarning"]), false);
  assert.equal(isSqliteExperimentalWarning(message, ["DeprecationWarning"]), false);
  assert.equal(isSqliteExperimentalWarning(message, []), false);
});

test("MCP server reports the package.json version", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { version: string };
  assert.equal(readPackageVersion(), pkg.version);
  const server = createMcpServer();
  const info = (server.server as unknown as { _serverInfo: { name: string; version: string } })._serverInfo;
  assert.deepEqual(info, { name: "bitrix-mcp", version: pkg.version });
});
