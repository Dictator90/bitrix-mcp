import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSecretFile, secretFilesAllowed } from "../src/config/secrets.js";
import { discoverFiles } from "../src/indexer/indexer.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RuntimePaths } from "../src/config/paths.js";

type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolRegistry = Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolResponse> }>;

test("isSecretFile flags credential, VCS, key and dump files", () => {
  for (const file of [
    "bitrix/.settings.php",
    "bitrix/.settings_extra.php",
    "bitrix/php_interface/dbconn.php",
    "local/php_interface/dbconn.php",
    "bitrix/license_key.php",
    ".env",
    ".env.local",
    "sub/.env.production",
    ".git/config",
    "bitrix/backup/20260101_full.tar.gz",
    "dump.sql",
    "BACKUP/site.SQL",
    "certs/server.pem",
    ".ssh/id_rsa",
    "auth.json",
    "bitrix-mcp.sqlite",
    "bitrix\\.settings.php"
  ]) {
    assert.equal(isSecretFile(file), true, file);
  }
  for (const file of ["index.php", "bitrix/modules/main/include.php", "local/php_interface/init.php", "docs/settings.md", "environment.php", "../outside/.env"]) {
    assert.equal(isSecretFile(file), false, file);
  }
  assert.equal(secretFilesAllowed({}), false);
  assert.equal(secretFilesAllowed({ BITRIX_MCP_ALLOW_SECRET_FILES: "1" }), true);
});

async function makeWorkspace(): Promise<{ root: string; paths: RuntimePaths }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-secrets-"));
  await fs.mkdir(path.join(root, "bitrix/php_interface"), { recursive: true });
  await fs.writeFile(path.join(root, "bitrix/.settings.php"), "<?php\nreturn ['connections' => ['value' => ['default' => ['password' => 'TOPSECRET']]]];\n", "utf8");
  await fs.writeFile(path.join(root, "bitrix/php_interface/dbconn.php"), "<?php\n$DBPassword = 'TOPSECRET';\n", "utf8");
  await fs.writeFile(path.join(root, "index.php"), "<?php\nfunction visible_helper() {}\n", "utf8");
  await fs.writeFile(path.join(root, "blob.php"), Buffer.from([0x3c, 0x3f, 0x00, 0x01, 0x02]));
  const paths: RuntimePaths = {
    workspaceRoot: root,
    dataDir: path.join(root, ".bitrix-mcp"),
    docsDir: path.join(root, "docs"),
    docsPaths: [path.join(root, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };
  return { root, paths };
}

test("bitrix_read_file_context refuses secret and binary files but reads normal ones", async () => {
  const { root, paths } = await makeWorkspace();
  try {
    const tools = (createMcpServer(paths) as unknown as { _registeredTools: ToolRegistry })._registeredTools;
    for (const file of ["bitrix/.settings.php", "bitrix/php_interface/dbconn.php", path.join(root, "bitrix/.settings.php")]) {
      await assert.rejects(
        tools.bitrix_read_file_context.handler({ file, line: 1, before: 0, after: 5, maxChars: 1000 }),
        (error: Error) => /secret-file restriction/.test(error.message) && !error.message.includes("TOPSECRET"),
        file
      );
    }
    await assert.rejects(tools.bitrix_read_file_context.handler({ file: "blob.php", line: 1, before: 0, after: 5, maxChars: 1000 }), /binary/);

    const normal = await tools.bitrix_read_file_context.handler({ file: "index.php", line: 1, before: 0, after: 5, maxChars: 1000 });
    assert.notEqual(normal.isError, true);
    assert.match(normal.content[0]?.text ?? "", /visible_helper/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("indexing skips secret files", async () => {
  const { root } = await makeWorkspace();
  try {
    const { queued } = await discoverFiles(root, { kind: "project" });
    assert.ok(queued.includes("index.php"));
    assert.equal(queued.some((file) => file.endsWith(".settings.php") || file.endsWith("dbconn.php")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
