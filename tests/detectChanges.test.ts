import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { detectChanges, detectChangedFileKind, diffSymbols, formatDetectChangesText, scoreChangeRisk, validateGitBase } from "../src/indexer/detectChanges.js";
import { getImpactRadius } from "../src/indexer/graph.js";
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
  assert.equal(detectChangedFileKind("bitrix/modules/main/install/index.php"), "install");
  assert.equal(detectChangedFileKind("bitrix/modules/iblock/install/components/bitrix/news.list/component.php"), "install");
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
  assert.deepEqual(result.changedFiles, [{ file: "index.php", kind: "project", status: "modified" }]);
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
    "deletedFiles",
    "symbolDiff",
    "impact",
    "risk",
    "recommendations"
  ]);
  assert.deepEqual(result.summary, { files: 1, symbols: 0, events: 0, moduleUsages: 0, agents: 0, mailEvents: 0, components: 0, ormEntities: 0, ormUsages: 0, iblockUsages: 0, hlblockUsages: 0, options: 0, relations: 0, deletedFiles: 0, untrackedFiles: 0, symbolsAdded: 0, symbolsRemoved: 0, symbolsChanged: 0 });
  assert.deepEqual(result.deletedFiles, []);
  assert.equal(result.symbolDiff?.totals.files, 0);
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

const SERVICE_V1 = String.raw`<?php
namespace Vendor\Module;

class Service
{
    public function keep(): void
    {
    }

    public function resign(int $id): void
    {
    }

    public function drop(): void
    {
    }
}
`;

const SERVICE_V2 = String.raw`<?php
namespace Vendor\Module;

class Service
{
    // shifted by a comment: moving alone is not a change

    public function keep(): void
    {
    }

    public function resign(string $code, int $id = 0): void
    {
    }

    public function fresh(): array
    {
        return [];
    }
}
`;

async function commitService(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, "local/lib"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "local/lib/service.php"), SERVICE_V1, "utf8");
  await git(workspaceRoot, ["add", "."]);
  await git(workspaceRoot, ["commit", "-m", "service"]);
}

function diffFor(result: Awaited<ReturnType<typeof detectChanges>>, file: string) {
  return result.symbolDiff?.files.find((entry) => entry.file === file);
}

test("detect changes symbol diff compares a fresh index against the git base", async () => {
  const { workspaceRoot, dataDir, paths } = await createGitWorkspace();
  await commitService(workspaceRoot);
  await fs.writeFile(path.join(workspaceRoot, "local/lib/service.php"), SERVICE_V2, "utf8");
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });

  const result = await detectChanges(paths, { base: "HEAD", includeImpact: false });
  const diff = diffFor(result, "local/lib/service.php");

  assert.equal(diff?.baseline, "git");
  assert.deepEqual(diff?.added.map((symbol) => symbol.name), ["Vendor\\Module\\Service::fresh"]);
  assert.deepEqual(diff?.removed.map((symbol) => symbol.name), ["Vendor\\Module\\Service::drop"]);
  const resign = diff?.changed.find((symbol) => symbol.name === "Vendor\\Module\\Service::resign");
  assert.deepEqual(resign?.reasons, ["signature"]);
  assert.match(resign?.after.signature ?? "", /string \$code/u);
  assert.equal(diff?.changed.some((symbol) => symbol.name === "Vendor\\Module\\Service::keep"), false);
  assert.ok(diff?.changed.some((symbol) => symbol.type === "class" && symbol.reasons.includes("span")));
  assert.equal(result.summary.symbolsAdded, 1);
  assert.equal(result.summary.symbolsRemoved, 1);
  assert.equal(result.symbolDiff?.staleIndexFiles, 0);
  assert.ok(result.risk.reasons.includes("removed symbols (possible breaking change)"));
  assert.ok(result.recommendations.some((item) => item.includes("re-signed symbols")));
  assert.match(formatDetectChangesText(result), /- method Vendor\\Module\\Service::drop/u);
});

test("detect changes symbol diff uses a stale index as the before state", async () => {
  const { workspaceRoot, dataDir, paths } = await createGitWorkspace();
  await commitService(workspaceRoot);
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });
  await fs.writeFile(path.join(workspaceRoot, "local/lib/service.php"), SERVICE_V2, "utf8");

  const result = await detectChanges(paths, { base: "HEAD", includeImpact: false });
  const diff = diffFor(result, "local/lib/service.php");

  assert.equal(diff?.baseline, "index");
  assert.deepEqual(diff?.added.map((symbol) => symbol.name), ["Vendor\\Module\\Service::fresh"]);
  assert.deepEqual(diff?.removed.map((symbol) => symbol.name), ["Vendor\\Module\\Service::drop"]);
  assert.equal(result.symbolDiff?.staleIndexFiles, 1);
  assert.ok(result.recommendations.some((item) => item.includes("index is older than the working tree")));

  const fromGit = await detectChanges(paths, { base: "HEAD", includeImpact: false, diffBaseline: "git" });
  assert.equal(diffFor(fromGit, "local/lib/service.php")?.baseline, "git");
  const disabled = await detectChanges(paths, { base: "HEAD", includeImpact: false, symbolDiff: false });
  assert.equal("symbolDiff" in disabled, false);
});

test("detect changes reports deleted files with their indexed symbols", async () => {
  const { workspaceRoot, dataDir, paths } = await createGitWorkspace();
  await commitService(workspaceRoot);
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });
  await fs.rm(path.join(workspaceRoot, "local/lib/service.php"));

  const result = await detectChanges(paths, { base: "HEAD", includeImpact: false });

  assert.deepEqual(result.changedFiles, [{ file: "local/lib/service.php", kind: "project", status: "deleted" }]);
  assert.equal(result.summary.deletedFiles, 1);
  const deleted = result.deletedFiles[0];
  assert.equal(deleted?.source, "index");
  assert.equal(deleted?.symbolCount, 4);
  assert.ok(deleted?.symbols.some((symbol) => (symbol as { fullyQualifiedName?: string }).fullyQualifiedName === "Vendor\\Module\\Service::drop"));
  assert.equal(diffFor(result, "local/lib/service.php")?.removed.length, 4);
  assert.ok(result.risk.reasons.includes("deleted files that declared symbols"));

  // Without an index the deleted file's symbols come from the git base.
  const emptyDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-detect-empty-"));
  const unindexed = await detectChanges({ ...paths, dataDir: emptyDataDir }, { base: "HEAD", includeImpact: false });
  assert.equal(unindexed.deletedFiles[0]?.source, "git");
  assert.equal(unindexed.deletedFiles[0]?.symbolCount, 4);
});

test("detect changes includes untracked files", async () => {
  const { workspaceRoot, paths } = await createGitWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "local/lib"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "local/lib/service.php"), SERVICE_V1, "utf8");

  const result = await detectChanges(paths, { includeImpact: false });

  assert.deepEqual(result.changedFiles, [{ file: "local/lib/service.php", kind: "project", status: "untracked" }]);
  assert.equal(result.summary.untrackedFiles, 1);
  assert.equal(diffFor(result, "local/lib/service.php")?.added.length, 4);
  assert.equal(result.summary.symbolsRemoved, 0);
});

test("detect changes and impact radius surface git errors as warnings", async () => {
  const { paths, dataDir } = await createGitWorkspace();
  const result = await detectChanges(paths, { base: "no-such-branch" });
  assert.deepEqual(result.changedFiles, []);
  assert.ok(result.warnings?.some((warning) => warning.includes("Unable to read git changes for base no-such-branch")));

  const impact = await getImpactRadius(sqlitePath(dataDir), { base: "no-such-branch", workspaceRoot: paths.workspaceRoot });
  assert.deepEqual(impact.changedFiles, []);
  assert.ok(impact.warnings?.some((warning) => warning.includes("no-such-branch")));
});

test("symbol diff matches PHP names case-insensitively and ignores moves", () => {
  const before = [
    { type: "class" as const, name: "Vendor\\Foo", fullyQualifiedName: "Vendor\\Foo", file: "a.php", line: 3, lineEnd: 10, signature: "class Foo" },
    { type: "method" as const, name: "run", fullyQualifiedName: "Vendor\\Foo::run", file: "a.php", line: 5, lineEnd: 7, signature: "public function run()" },
    { type: "static_call" as const, name: "Bar::baz", file: "a.php", line: 6 }
  ];
  const after = [
    { type: "class" as const, name: "vendor\\FOO", fullyQualifiedName: "vendor\\FOO", file: "a.php", line: 13, lineEnd: 20, signature: "class Foo" },
    { type: "method" as const, name: "RUN", fullyQualifiedName: "Vendor\\Foo::RUN", file: "a.php", line: 15, lineEnd: 19, signature: "public function run()" }
  ];
  const diff = diffSymbols(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed.map((change) => [change.name, change.reasons]), [["Vendor\\Foo::RUN", ["span"]]]);
});
