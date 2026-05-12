import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { detectChanges, detectChangedFileKind, scoreChangeRisk, validateGitBase } from "../src/indexer/detectChanges.js";
import { buildIndex } from "../src/indexer/indexer.js";
import { writeBitrixRelations } from "../src/indexer/sqliteStore.js";
import { createMcpServer } from "../src/mcp/server.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve("tests/fixtures/project");

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createGitWorkspace(): Promise<{ workspaceRoot: string; dataDir: string; paths: RuntimePaths }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-workspace-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-data-"));
  await fs.cp(fixtureRoot, workspaceRoot, { recursive: true });
  await git(workspaceRoot, ["init"]);
  await git(workspaceRoot, ["config", "user.email", "tests@example.com"]);
  await git(workspaceRoot, ["config", "user.name", "Bitrix MCP Tests"]);
  await git(workspaceRoot, ["add", "."]);
  await git(workspaceRoot, ["commit", "-m", "initial"]);
  await git(workspaceRoot, ["commit", "--allow-empty", "-m", "baseline"]);
  const paths: RuntimePaths = {
    workspaceRoot,
    dataDir,
    docsDir: path.join(workspaceRoot, "docs"),
    docsPaths: [path.join(workspaceRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  return { workspaceRoot, dataDir, paths };
}

test("detect changes validates safe git base refs", () => {
  assert.equal(validateGitBase(undefined), "HEAD~1");
  assert.equal(validateGitBase("origin/main"), "origin/main");
  assert.equal(validateGitBase("release/2026.05"), "release/2026.05");
  assert.throws(() => validateGitBase("origin/main -- index.php"), /Unsafe git base/);
  assert.throws(() => validateGitBase("../main"), /Unsafe git base/);
  assert.throws(() => validateGitBase("-bad"), /Unsafe git base/);
  assert.throws(() => validateGitBase("main@{1}"), /Unsafe git base/);
});

test("detect changes classifies changed file kinds", () => {
  assert.equal(detectChangedFileKind("local/php_interface/init.php"), "project");
  assert.equal(detectChangedFileKind("local/templates/site/header.php"), "template");
  assert.equal(detectChangedFileKind("local/templates/site/components/bitrix/catalog/.default/template.php"), "component");
  assert.equal(detectChangedFileKind("bitrix/modules/main/lib/event.php"), "bitrix");
  assert.equal(detectChangedFileKind("local/modules/vendor.module/install/index.php"), "install");
  assert.equal(detectChangedFileKind("docs/readme.md"), "docs");
  assert.equal(detectChangedFileKind("local/modules/vendor.module/install/js/admin/widget.ts"), "install");
  assert.equal(detectChangedFileKind("upload/logo.svg"), "asset");
  assert.equal(detectChangedFileKind(".env.example"), "unknown");
});

test("detect changes risk scoring is deterministic", () => {
  const risk = scoreChangeRisk({
    changedFiles: [
      { file: "local/php_interface/init.php", kind: "project" },
      { file: "local/templates/site/components/bitrix/catalog/.default/template.php", kind: "component" }
    ],
    changedEvents: [{ type: "event", name: "main:OnBeforeProlog", module: "main", file: "local/php_interface/init.php", line: 1 }],
    changedAgents: [],
    changedMailEvents: [],
    relatedRelations: []
  });

  assert.equal(risk.level, "high");
  assert.equal(risk.score, 100);
  assert.deepEqual(risk.reasons, [
    "changed local/php_interface/init.php",
    "changed template.php",
    "changed component files for catalog/order/basket",
    "changed event handler for main/sale/catalog"
  ]);
});

test("detect changes maps changed files to indexed symbols, events, module usages, and relations", async () => {
  const { workspaceRoot, dataDir, paths } = await createGitWorkspace();
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });
  await writeBitrixRelations(sqlitePath(dataDir), [{
    sourceType: "event",
    sourceName: "main:OnBeforeProlog",
    targetType: "function",
    targetName: "demo_helper",
    relationType: "handled_by_event_handler",
    file: "index.php",
    line: 13,
    module: "main",
    kind: "project",
    signature: "AddEventHandler('main', 'OnBeforeProlog', ['Demo', 'handler']);"
  }], { clearFile: "index.php" });
  await fs.appendFile(path.join(workspaceRoot, "index.php"), "\n// changed\n", "utf8");

  const result = await detectChanges(paths, { maxItems: 20 });

  assert.equal(result.base, "HEAD~1");
  assert.deepEqual(result.changedFiles, [{ file: "index.php", kind: "project" }]);
  assert.equal(result.summary.files, 1);
  assert.ok(result.summary.symbols >= 2);
  assert.equal(result.summary.events, 1);
  assert.ok(result.summary.relations >= 1);
  assert.ok(result.changedSymbols.some((symbol) => (symbol as { name?: string }).name === "demo_helper"));
  assert.ok(result.changedEvents.some((event) => (event as { name?: string; eventName?: string }).name === "main:OnBeforeProlog" || (event as { eventName?: string }).eventName === "OnBeforeProlog"));
  assert.ok(result.relatedRelations.some((relation) => (relation as { relationType?: string }).relationType === "handled_by_event_handler"));
});

test("detect changes compact output shape includes all top-level fields", async () => {
  const { workspaceRoot, paths } = await createGitWorkspace();
  await fs.appendFile(path.join(workspaceRoot, "docs/framework/search.md"), "\nUpdate docs.\n", "utf8");

  const result = await detectChanges(paths, { kind: "docs" });

  assert.deepEqual(Object.keys(result), [
    "base",
    "changedFiles",
    "summary",
    "changedSymbols",
    "changedEvents",
    "changedModuleUsages",
    "changedAgents",
    "changedMailEvents",
    "relatedRelations",
    "risk",
    "recommendations"
  ]);
  assert.deepEqual(result.summary, { files: 1, symbols: 0, events: 0, moduleUsages: 0, agents: 0, mailEvents: 0, relations: 0 });
  assert.equal(result.risk.level, "low");
});

test("MCP registers bitrix_detect_changes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-server-"));
  const server = createMcpServer({ workspaceRoot: fixtureRoot, dataDir, docsDir: path.join(fixtureRoot, "docs"), docsPaths: [], embeddingsUrl: "http://127.0.0.1:8765", semanticEnabled: false });
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(tools.bitrix_detect_changes);
});
