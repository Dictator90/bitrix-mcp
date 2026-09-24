import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBitrixConnections, redactConnection, resolveConnection, withReadOnlyCredentials } from "../src/liveapi/settingsPhpParser.js";
import type { RuntimePaths } from "../src/config/paths.js";

const SETTINGS_PHP = `<?php
return array(
  'utf_mode' => array('value' => true, 'readonly' => true),
  'connections' => array(
    'value' => array(
      'default' => array(
        'className' => '\\\\Bitrix\\\\Main\\\\DB\\\\MysqliConnection',
        'host' => 'localhost:3307',
        'database' => 'sitemanager',
        'login' => 'root',
        'password' => 's3cr3t',
        'options' => 2,
      ),
      'analytics' => array(
        'className' => '\\\\Bitrix\\\\Main\\\\DB\\\\MysqliConnection',
        'host' => 'db.internal',
        'database' => 'stats',
        'login' => 'reader',
        'password' => '',
        'options' => 2,
      ),
    ),
    'readonly' => true,
  ),
);
`;

async function makeBitrixProject(contents = SETTINGS_PHP): Promise<{ paths: RuntimePaths; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-settings-"));
  await fs.mkdir(path.join(root, "bitrix"), { recursive: true });
  await fs.writeFile(path.join(root, "bitrix", ".settings.php"), contents, "utf8");
  const paths: RuntimePaths = {
    workspaceRoot: root,
    dataDir: path.join(root, ".bitrix-mcp"),
    docsDir: path.join(root, "docs"),
    docsPaths: [path.join(root, "docs")],
    bitrixRoot: root,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: true,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };
  return { paths, root };
}

test("readBitrixConnections extracts named connections and splits host:port", async () => {
  const { paths, root } = await makeBitrixProject();
  try {
    const { connections, source, error } = await readBitrixConnections(paths);
    assert.equal(error, undefined);
    assert.equal(source, path.join(root, "bitrix", ".settings.php"));
    assert.equal(connections.length, 2);

    const def = connections.find((c) => c.name === "default");
    assert.ok(def, "default connection present");
    assert.equal(def?.host, "localhost");
    assert.equal(def?.port, 3307);
    assert.equal(def?.database, "sitemanager");
    assert.equal(def?.login, "root");
    assert.equal(def?.password, "s3cr3t");

    const analytics = connections.find((c) => c.name === "analytics");
    assert.equal(analytics?.host, "db.internal");
    assert.equal(analytics?.port, undefined);
    assert.equal(analytics?.database, "stats");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("redactConnection hides the password and reports hasPassword", async () => {
  const { paths, root } = await makeBitrixProject();
  try {
    const { connections, source } = await readBitrixConnections(paths);
    const def = connections.find((c) => c.name === "default");
    assert.ok(def);
    const redacted = redactConnection(def!, source);
    assert.equal(redacted.hasPassword, true);
    assert.equal(redacted.login, "root");
    assert.equal(redacted.database, "sitemanager");
    assert.equal((redacted as unknown as Record<string, unknown>).password, undefined);

    const analytics = connections.find((c) => c.name === "analytics");
    const redactedAnalytics = redactConnection(analytics!, source);
    assert.equal(redactedAnalytics.hasPassword, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveConnection selects by name and defaults sensibly", async () => {
  const { paths, root } = await makeBitrixProject();
  try {
    const def = await resolveConnection(paths, "default");
    assert.equal(def?.database, "sitemanager");

    const analytics = await resolveConnection(paths, "analytics");
    assert.equal(analytics?.database, "stats");

    const missing = await resolveConnection(paths, "nope");
    assert.equal(missing, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readBitrixConnections reports an error when bitrixRoot is unknown", async () => {
  const paths: RuntimePaths = {
    workspaceRoot: "/nonexistent",
    dataDir: "/nonexistent/.bitrix-mcp",
    docsDir: "/nonexistent/docs",
    docsPaths: ["/nonexistent/docs"],
    bitrixRoot: undefined,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: true,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };
  const { connections, error } = await readBitrixConnections(paths);
  assert.equal(connections.length, 0);
  assert.ok(error && error.length > 0);
});

test("readBitrixConnections merges .settings_extra.php, maps sockets, and derives charset from utf_mode", async () => {
  const { paths, root } = await makeBitrixProject(`<?php
return [
  'utf_mode' => ['value' => false],
  'connections' => ['value' => [
    'default' => ['host' => 'localhost:/run/mysqld/mysqld.sock', 'database' => 'site', 'login' => 'u', 'password' => 'p'],
    'stats' => ['host' => 'db', 'database' => 'stats', 'login' => 'u', 'password' => 'p'],
  ]],
];
`);
  try {
    await fs.writeFile(path.join(root, "bitrix", ".settings_extra.php"), "<?php\nreturn ['connections' => ['value' => ['stats' => ['host' => 'db-extra:3310', 'database' => 'stats2', 'login' => 'x', 'password' => 'y']]]];\n", "utf8");
    const { connections } = await readBitrixConnections(paths);
    const byName = new Map(connections.map((connection) => [connection.name, connection]));
    assert.equal(byName.get("default")?.socketPath, "/run/mysqld/mysqld.sock");
    assert.equal(byName.get("default")?.host, "localhost");
    assert.equal(byName.get("default")?.charset, "CP1251_GENERAL_CI");
    assert.equal(byName.get("stats")?.host, "db-extra");
    assert.equal(byName.get("stats")?.port, 3310);
    assert.equal(byName.get("stats")?.database, "stats2");
    assert.equal(redactConnection(byName.get("default")!, "x").socketPath, "/run/mysqld/mysqld.sock");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("regex fallback only reads the connections section", async () => {
  const { paths, root } = await makeBitrixProject(`<?php
return [
  'cache' => ['value' => ['type' => ['class_name' => getenv('X')], 'host' => 'memcache.local', 'database' => 'nope']],
  'connections' => ['value' => ['default' => ['host' => 'mysql.local', 'database' => 'site', 'login' => 'u', 'password' => getenv('DB_PASS') ?: 'p']]],
  'broken' => [
`);
  try {
    const { connections } = await readBitrixConnections(paths);
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.host, "mysql.local");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("withReadOnlyCredentials swaps login/password only when configured", () => {
  const conn = { name: "default", host: "h", database: "d", login: "root", password: "rootpw" };
  assert.deepEqual(withReadOnlyCredentials(conn, {}), conn);
  assert.deepEqual(withReadOnlyCredentials(conn, { BITRIX_MCP_DB_READONLY_USER: "reader", BITRIX_MCP_DB_READONLY_PASSWORD: "rpw" }), { ...conn, login: "reader", password: "rpw" });
});
