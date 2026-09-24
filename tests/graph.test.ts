import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sqlitePath } from "../src/config/paths.js";
import { getGraphNeighbors, getImpactRadius, normalizeGraphNode, traverseGraph } from "../src/indexer/graph.js";
import { buildIndex } from "../src/indexer/indexer.js";
import { ensureSqliteStore, searchBitrixRelations, searchInheritanceRelations, writeBitrixRelations } from "../src/indexer/sqliteStore.js";

async function tempDb(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-graph-"));
  const dbFile = sqlitePath(dataDir);
  await ensureSqliteStore(dbFile);
  return dbFile;
}

async function seedGraph(dbFile: string): Promise<void> {
  await writeBitrixRelations(dbFile, [
    { sourceType: "file", sourceName: "local/php_interface/init.php", targetType: "event", targetName: "main:OnBeforeProlog", relationType: "registers_event_handler", file: "local/php_interface/init.php", line: 12, module: "main", kind: "project" },
    { sourceType: "event", sourceName: "main:OnBeforeProlog", targetType: "method", targetName: "Vendor\\Module\\Handler::onBeforeProlog", relationType: "handles_event", file: "local/php_interface/init.php", line: 13, module: "main", kind: "project" },
    { sourceType: "method", sourceName: "Vendor\\Module\\Handler::onBeforeProlog", targetType: "module", targetName: "iblock", relationType: "includes_module", file: "local/modules/vendor.module/lib/handler.php", line: 20, module: "iblock", kind: "project" },
    { sourceType: "component", sourceName: "bitrix:catalog.section", targetType: "iblock", targetName: "CATALOG_IBLOCK_ID", relationType: "uses_iblock", file: "local/templates/site/components/bitrix/catalog.section/.default/template.php", line: 5, kind: "template" },
    { sourceType: "iblock", sourceName: "CATALOG_IBLOCK_ID", targetType: "component", targetName: "bitrix:catalog.section", relationType: "used_by_component", file: "local/templates/site/components/bitrix/catalog.section/.default/template.php", line: 5, kind: "template" },
    { sourceType: "orm_entity", sourceName: "Vendor\\Module\\ProductTable", targetType: "orm_entity", targetName: "Bitrix\\Main\\UserTable", relationType: "references_orm_entity", file: "local/modules/vendor.module/lib/producttable.php", line: 30, kind: "project" }
  ]);
}

test("graph node normalization creates stable ids", () => {
  assert.deepEqual(normalizeGraphNode(" File ", "local\\php_interface\\init.php "), { id: "file:local/php_interface/init.php", type: "file", name: "local/php_interface/init.php" });
  assert.deepEqual(normalizeGraphNode("event", "main:OnBeforeProlog"), { id: "event:main:OnBeforeProlog", type: "event", name: "main:OnBeforeProlog" });
});

test("graph neighbors returns direct outgoing neighbors", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getGraphNeighbors(dbFile, { type: "event", name: "main:OnBeforeProlog" });
  assert.equal(result.neighbors.length, 1);
  assert.equal(result.neighbors[0]?.direction, "out");
  assert.equal(result.neighbors[0]?.type, "method");
});

test("graph neighbors returns direct incoming neighbors", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getGraphNeighbors(dbFile, { type: "event", name: "main:OnBeforeProlog" }, { direction: "in" });
  assert.equal(result.neighbors.length, 1);
  assert.equal(result.neighbors[0]?.direction, "in");
  assert.equal(result.neighbors[0]?.type, "file");
});

test("graph neighbors returns both-direction neighbors", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getGraphNeighbors(dbFile, { type: "event", name: "main:OnBeforeProlog" }, { direction: "both" });
  assert.deepEqual(result.neighbors.map((node) => node.direction).sort(), ["in", "out"]);
});

test("graph traversal supports BFS depth 1", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await traverseGraph(dbFile, { type: "file", name: "local/php_interface/init.php" }, { maxDepth: 1 });
  assert.equal(result.nodes.some((node) => node.id === "event:main:OnBeforeProlog" && node.depth === 1), true);
  assert.equal(result.nodes.some((node) => node.type === "method"), false);
});

test("graph traversal supports BFS depth 2", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await traverseGraph(dbFile, { type: "file", name: "local/php_interface/init.php" }, { maxDepth: 2 });
  assert.equal(result.nodes.some((node) => node.id === "method:Vendor\\Module\\Handler::onBeforeProlog" && node.depth === 2), true);
});

test("graph traversal protects against cycles", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await traverseGraph(dbFile, { type: "component", name: "bitrix:catalog.section" }, { direction: "both", maxDepth: 5 });
  assert.ok(result.nodes.length <= 2);
  assert.equal(result.truncated, false);
});

test("graph traversal filters by relation type", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await traverseGraph(dbFile, { type: "event", name: "main:OnBeforeProlog" }, { relationTypes: ["includes_module"], maxDepth: 2 });
  assert.equal(result.edges.length, 0);
});

test("graph traversal marks limit truncation", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await traverseGraph(dbFile, { type: "file", name: "local/php_interface/init.php" }, { maxDepth: 3, limit: 2 });
  assert.equal(result.truncated, true);
});

test("impact radius starts from changed file relations", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getImpactRadius(dbFile, { files: ["local/php_interface/init.php"], maxDepth: 2 });
  assert.equal(result.changedFiles[0], "local/php_interface/init.php");
  assert.equal(result.startNodes.some((node) => node.id === "file:local/php_interface/init.php"), true);
  assert.equal(result.impacted.events.some((node) => node.id === "event:main:OnBeforeProlog"), true);
});

test("impact radius groups impacted entities by type", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getImpactRadius(dbFile, { files: ["local/templates/site/components/bitrix/catalog.section/.default/template.php"], maxDepth: 2 });
  assert.equal(result.impacted.components.some((node) => node.id === "component:bitrix:catalog.section"), true);
  assert.equal(result.impacted.iblocks.some((node) => node.id === "iblock:CATALOG_IBLOCK_ID"), true);
});

test("impact radius risk scores high-impact relations", async () => {
  const dbFile = await tempDb();
  await seedGraph(dbFile);
  const result = await getImpactRadius(dbFile, { files: ["local/php_interface/init.php"], maxDepth: 2, includeRisk: true });
  assert.ok(result.risk.score >= 15);
  assert.ok(result.risk.reasons.some((reason) => reason.includes("handles_event") || reason.includes("registers_event_handler")));
});

async function indexWorkspace(files: Record<string, string>): Promise<{ workspaceRoot: string; dbFile: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-graph-ws-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-graph-data-"));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspaceRoot, file)), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, file), content, "utf8");
  }
  await buildIndex({ root: workspaceRoot, kind: "project", outFile: path.join(dataDir, "unused.json"), force: true });
  return { workspaceRoot, dbFile: sqlitePath(dataDir) };
}

const INHERITANCE_FILES: Record<string, string> = {
  "local/lib/base.php": String.raw`<?php
namespace Vendor\Module;
interface Contract {}
trait Loggable {}
abstract class Base implements Contract
{
    use Loggable;
}
`,
  "local/lib/middle.php": String.raw`<?php
namespace Vendor\Module;
class Middle extends base {}
`,
  "local/lib/leaf.php": String.raw`<?php
namespace Vendor\Module;
class Leaf extends \VENDOR\MODULE\Middle {}
`,
  "local/lib/other.php": String.raw`<?php
namespace Other;
class Base {}
class Child extends Base {}
`,
  "local/lib/producttable.php": String.raw`<?php
namespace Vendor\Module;
use Bitrix\Main\ORM\Data\DataManager;
class ProductTable extends DataManager
{
    public static function getTableName() { return 'vendor_product'; }
    public static function getMap() { return []; }
}
`
};

test("inheritance edges use canonical class nodes so chains can be walked case-insensitively", async () => {
  const { dbFile } = await indexWorkspace(INHERITANCE_FILES);
  const relations = await searchBitrixRelations(dbFile, { sourceType: "class", sourceName: "Vendor\\Module\\Base", limit: 10 }) ?? [];
  assert.deepEqual(relations.map((relation) => [relation.relationType, relation.targetType, relation.targetName]).sort(), [
    ["implements", "class", "Vendor\\Module\\Contract"],
    ["uses_trait", "class", "Vendor\\Module\\Loggable"]
  ]);

  const result = await traverseGraph(dbFile, { type: "class", name: "vendor\\module\\leaf" }, { maxDepth: 4, relationTypes: ["extends", "implements", "uses_trait"] });
  const reached = new Map(result.nodes.map((node) => [node.name.toLowerCase(), node.depth]));
  assert.equal(reached.get("vendor\\module\\middle"), 1);
  assert.equal(reached.get("vendor\\module\\base"), 2);
  assert.equal(reached.get("vendor\\module\\contract"), 3);
  assert.equal(reached.get("vendor\\module\\loggable"), 3);
  assert.equal(result.nodes.every((node) => node.type === "class"), true);
  // `extends base` and the declaration `Base` are one node, not two.
  assert.equal(result.nodes.filter((node) => node.name.toLowerCase() === "vendor\\module\\base").length, 1);

  const incoming = await getGraphNeighbors(dbFile, { type: "interface", name: "\\Vendor\\Module\\Contract" }, { direction: "in" });
  assert.deepEqual(incoming.neighbors.map((neighbor) => neighbor.name), ["Vendor\\Module\\Base"]);
});

test("ORM entities do not write a duplicate extends edge", async () => {
  const { dbFile } = await indexWorkspace(INHERITANCE_FILES);
  const relations = await searchBitrixRelations(dbFile, { sourceType: "class", sourceName: "Vendor\\Module\\ProductTable", relationType: "extends", limit: 10 }) ?? [];
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.targetType, "class");
});

test("legacy parent_class/interface/trait rows are read as class nodes", async () => {
  const dbFile = await tempDb();
  await writeBitrixRelations(dbFile, [
    { sourceType: "class", sourceName: "App\\Child", targetType: "parent_class", targetName: "App\\Parent", relationType: "extends", file: "local/lib/child.php", line: 3, kind: "project" },
    { sourceType: "class", sourceName: "App\\Parent", targetType: "interface", targetName: "App\\Contract", relationType: "implements", file: "local/lib/parent.php", line: 3, kind: "project" }
  ]);
  const result = await traverseGraph(dbFile, { type: "class", name: "App\\Child" }, { maxDepth: 3 });
  assert.deepEqual(result.nodes.map((node) => node.id), ["class:App\\Child", "class:App\\Parent", "class:App\\Contract"]);
  const incoming = await getGraphNeighbors(dbFile, { type: "parent_class", name: "app\\parent" }, { direction: "in" });
  assert.deepEqual(incoming.neighbors.map((neighbor) => neighbor.id), ["class:App\\Child"]);
  const legacy = await searchInheritanceRelations(dbFile, { target: "App\\Parent" }) ?? [];
  assert.equal(legacy[0]?.targetType, "class");
  assert.equal(legacy[0]?.metadata?.targetKind, "class");
});

test("inheritance search matches exact FQNs and exact short names", async () => {
  const { dbFile } = await indexWorkspace(INHERITANCE_FILES);
  const fqn = await searchInheritanceRelations(dbFile, { target: "Vendor\\Module\\Base", relation: "extends" }) ?? [];
  assert.deepEqual(fqn.map((relation) => relation.sourceName), ["Vendor\\Module\\Middle"]);
  const short = await searchInheritanceRelations(dbFile, { target: "Base", relation: "extends" }) ?? [];
  assert.deepEqual(short.map((relation) => relation.sourceName).sort(), ["Other\\Child", "Vendor\\Module\\Middle"]);
  const suffixOnly = await searchInheritanceRelations(dbFile, { target: "ase", relation: "extends" }) ?? [];
  assert.deepEqual(suffixOnly, []);
});

test("inheritance search follows descendants transitively and is cycle-safe", async () => {
  const { dbFile } = await indexWorkspace(INHERITANCE_FILES);
  const direct = await searchInheritanceRelations(dbFile, { target: "Vendor\\Module\\Contract", relation: "implements" }) ?? [];
  assert.deepEqual(direct.map((relation) => relation.sourceName), ["Vendor\\Module\\Base"]);
  const transitive = await searchInheritanceRelations(dbFile, { target: "Vendor\\Module\\Contract", relation: "implements", transitive: true }) ?? [];
  assert.deepEqual(transitive.map((relation) => [relation.sourceName, relation.metadata?.depth]), [
    ["Vendor\\Module\\Base", 1],
    ["Vendor\\Module\\Middle", 2],
    ["Vendor\\Module\\Leaf", 3]
  ]);
  const shallow = await searchInheritanceRelations(dbFile, { target: "Vendor\\Module\\Contract", transitive: true, maxDepth: 2 }) ?? [];
  assert.equal(shallow.some((relation) => relation.sourceName === "Vendor\\Module\\Leaf"), false);

  const cycleDb = await tempDb();
  await writeBitrixRelations(cycleDb, [
    { sourceType: "class", sourceName: "A", targetType: "class", targetName: "B", relationType: "extends", file: "a.php", line: 1 },
    { sourceType: "class", sourceName: "B", targetType: "class", targetName: "A", relationType: "extends", file: "b.php", line: 1 }
  ]);
  const cycle = await searchInheritanceRelations(cycleDb, { target: "A", transitive: true, maxDepth: 10 }) ?? [];
  assert.deepEqual(cycle.map((relation) => relation.sourceName), ["B", "A"]);
});

test("graph traversal caps hub nodes per node and marks them truncated", async () => {
  const dbFile = await tempDb();
  await writeBitrixRelations(dbFile, Array.from({ length: 60 }, (_, index) => ({
    sourceType: "file", sourceName: `local/file${index}.php`, targetType: "module", targetName: "iblock", relationType: "includes_module", file: `local/file${index}.php`, line: 1
  })));
  const capped = await traverseGraph(dbFile, { type: "module", name: "iblock" }, { direction: "in", maxDepth: 1, limit: 1000, maxEdgesPerNode: 10 });
  assert.equal(capped.edges.length, 10);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.truncatedNodes, ["module:iblock"]);

  const full = await traverseGraph(dbFile, { type: "module", name: "iblock" }, { direction: "in", maxDepth: 1, limit: 1000 });
  assert.equal(full.edges.length, 60);
  assert.equal(full.truncated, false);
  assert.equal(full.truncatedNodes, undefined);

  const limited = await traverseGraph(dbFile, { type: "module", name: "iblock" }, { direction: "in", maxDepth: 1, limit: 5 });
  assert.equal(limited.truncated, true);
  assert.ok(limited.edges.length <= 5);
});

test("graph traversal batches a wide frontier in one BFS level", async () => {
  const dbFile = await tempDb();
  const relations = Array.from({ length: 900 }, (_, index) => ({
    sourceType: "module", sourceName: "hub", targetType: "class", targetName: `App\\C${index}`, relationType: "uses", file: "hub.php", line: index + 1
  }));
  relations.push({ sourceType: "class", sourceName: "app\\c899", targetType: "option", targetName: "main:last", relationType: "uses_option", file: "c899.php", line: 1 });
  await writeBitrixRelations(dbFile, relations);
  const result = await traverseGraph(dbFile, { type: "module", name: "hub" }, { maxDepth: 2, limit: 1000 });
  assert.equal(result.truncated, false);
  assert.ok(result.nodes.some((node) => node.id === "option:main:last" && node.depth === 2));
  const edge = result.edges.find((candidate) => candidate.relationType === "uses_option");
  assert.equal(edge?.source, "class:App\\C899");
});

test("impact radius starts from fully qualified method nodes of changed files", async () => {
  const { workspaceRoot, dbFile } = await indexWorkspace({
    "local/lib/handler.php": String.raw`<?php
namespace Vendor\Module;
class Handler
{
    public static function onBeforeProlog(): void {}
}
`
  });
  await writeBitrixRelations(dbFile, [
    { sourceType: "event", sourceName: "main:OnBeforeProlog", targetType: "method", targetName: "\\vendor\\module\\HANDLER::onbeforeprolog", relationType: "handles_event", file: "local/php_interface/init.php", line: 3, module: "main", kind: "project" }
  ]);
  const result = await getImpactRadius(dbFile, { files: ["local/lib/handler.php"], workspaceRoot, maxDepth: 1 });
  assert.ok(result.startNodes.some((node) => node.id === "method:Vendor\\Module\\Handler::onBeforeProlog"));
  assert.ok(result.startNodes.some((node) => node.id === "class:Vendor\\Module\\Handler"));
  assert.ok(result.impacted.events.some((node) => node.id === "event:main:OnBeforeProlog"));
  assert.ok(result.edges.some((edge) => edge.relationType === "handles_event" && edge.target === "method:Vendor\\Module\\Handler::onBeforeProlog"));
});
