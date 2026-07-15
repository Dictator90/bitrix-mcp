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
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
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
    "changedComponents",
    "changedOrmEntities",
    "changedOrmUsages",
    "changedIblockUsages",
    "changedHlblockUsages",
    "changedOptions",
    "relatedRelations",
    "impact",
    "risk",
    "recommendations"
  ]);
  assert.deepEqual(result.summary, { files: 1, symbols: 0, events: 0, moduleUsages: 0, agents: 0, mailEvents: 0, components: 0, ormEntities: 0, ormUsages: 0, iblockUsages: 0, hlblockUsages: 0, options: 0, relations: 0 });
  assert.deepEqual(result.impact?.impacted.events, []);
  assert.equal(result.risk.level, "low");
});


test("detect changes includes indexed components, ORM, iblock, hlblock, options, and impact controls", async () => {
  const { workspaceRoot, dataDir, paths } = await createGitWorkspace();
  await fs.appendFile(path.join(workspaceRoot, "index.php"), String.raw`
namespace Vendor\Module;
use Bitrix\Main\ORM\Data\DataManager;
use Bitrix\Main\Config\Option;
use Bitrix\Highloadblock\HighloadBlockTable;
class ProductTable extends DataManager
{
    public static function getTableName() { return 'vendor_product'; }
    public static function getMap() { return []; }
}
ProductTable::getList([]);
\CIBlockElement::GetList([], ['IBLOCK_ID' => CATALOG_IBLOCK_ID]);
HighloadBlockTable::compileEntity(['ID' => 3]);
Option::get('vendor.module', 'some_option');
`, "utf8");
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });

  const result = await detectChanges(paths, { maxItems: 50 });

  assert.ok(result.summary.components >= 1);
  assert.equal(result.summary.ormEntities, 1);
  assert.ok(result.summary.ormUsages >= 1);
  assert.ok(result.summary.iblockUsages >= 1);
  assert.ok(result.summary.hlblockUsages >= 1);
  assert.ok(result.summary.options >= 1);
  assert.ok(result.changedComponents.some((component) => (component as { name?: string }).name === "bitrix:news.list"));
  assert.ok(result.changedOrmEntities.some((entity) => (entity as { className?: string }).className === "Vendor\\Module\\ProductTable"));
  assert.ok(result.changedOrmUsages.some((usage) => (usage as { method?: string }).method === "getList"));
  assert.ok(result.changedIblockUsages.some((usage) => (usage as { api?: string }).api === "CIBlockElement::GetList"));
  assert.ok(result.changedHlblockUsages.some((usage) => (usage as { hlblockId?: string }).hlblockId === "3"));
  assert.ok(result.changedOptions.some((usage) => (usage as { name?: string }).name === "some_option"));
  assert.ok(result.impact);
  assert.ok(result.risk.reasons.length === new Set(result.risk.reasons).size);
  assert.ok(result.recommendations.includes("Check ORM getMap, table fields, references, filters, and migrations."));
  assert.ok(result.recommendations.includes("Check component params, cache, template rendering, and related assets."));

  const withoutImpact = await detectChanges(paths, { includeImpact: false });
  assert.equal("impact" in withoutImpact, false);
});

test("detect changes returns a warning instead of crashing outside git", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-nongit-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-nongit-data-"));
  const paths: RuntimePaths = {
    workspaceRoot,
    dataDir,
    docsDir: path.join(workspaceRoot, "docs"),
    docsPaths: [],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: false,
    dbAllowWrite: false,
    tinkerEnabled: false,
    phpBin: "php"
  };

  const result = await detectChanges(paths);

  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.summary.files, 0);
  assert.ok(result.warnings?.[0]?.includes("Unable to read git changes"));
});

test("MCP registers bitrix_detect_changes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-server-"));
  const server = createMcpServer({ workspaceRoot: fixtureRoot, dataDir, docsDir: path.join(fixtureRoot, "docs"), docsPaths: [], embeddingsUrl: "http://127.0.0.1:8765", semanticEnabled: false, dbEnabled: false, dbAllowWrite: false, tinkerEnabled: false, phpBin: "php" });
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(tools.bitrix_detect_changes);
});
