import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexCode } from "../src/indexer/actions.js";
import type { RuntimePaths } from "../src/config/paths.js";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

async function makeProject(): Promise<{ paths: RuntimePaths; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-install-src-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-install-db-"));
  await write(root, "bitrix/modules/main/lib/user.php", "<?php\nclass CUser {}\n");
  await write(root, "bitrix/modules/main/install/index.php", "<?php\nclass main_install {}\n");
  const paths: RuntimePaths = {
    workspaceRoot: root,
    dataDir,
    docsDir: path.join(root, "docs"),
    docsPaths: [],
    bitrixRoot: root,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  return { paths, root };
}

test("index-code skips install assets by default", async () => {
  const { paths } = await makeProject();
  const result = await indexCode(paths, { force: true });
  assert.ok(result.bitrixFiles >= 1, "bitrix core should still be indexed");
  assert.equal(result.installFiles, 0, "install assets must not be indexed by default");
});

test("index-code indexes install assets when includeInstall is set", async () => {
  const { paths } = await makeProject();
  const result = await indexCode(paths, { force: true, includeInstall: true });
  assert.ok(result.installFiles >= 1, "install assets should be indexed with includeInstall");
});
