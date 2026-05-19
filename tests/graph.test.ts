import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sqlitePath } from "../src/config/paths.js";
import { getGraphNeighbors, getImpactRadius, normalizeGraphNode, traverseGraph } from "../src/indexer/graph.js";
import { ensureSqliteStore, writeBitrixRelations } from "../src/indexer/sqliteStore.js";

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
