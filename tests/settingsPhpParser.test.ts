import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBitrixConnections, redactConnection, resolveConnection } from "../src/liveapi/settingsPhpParser.js";
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
