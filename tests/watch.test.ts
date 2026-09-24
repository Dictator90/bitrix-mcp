import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRuntimePaths, sqlitePath, type RuntimePaths } from "../src/config/paths.js";
import { indexAll, indexCode } from "../src/indexer/actions.js";
import { readIndexFromSqlite } from "../src/indexer/sqliteStore.js";
import { mergeReindexTargets, WatchScopeMapper, type ReindexTarget } from "../src/watch/scope.js";
import { formatWatchEvent, startWatch, type WatchEvent } from "../src/watch/watch.js";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function makeWorkspace(): Promise<RuntimePaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-watch-"));
  await write(root, "index.php", "<?php\nfunction project_home() {}\n");
  await write(root, "local/php_interface/init.php", "<?php\nfunction project_init() {}\n");
  await write(root, "local/templates/main/header.php", "<?php\nfunction main_header() {}\n");
  await write(root, "local/templates/other/footer.php", "<?php\nfunction other_footer() {}\n");
  await write(root, "local/components/acme/list/class.php", "<?php\nclass AcmeListComponent {}\n");
  await write(root, "bitrix/modules/main/lib/loader.php", "<?php\nnamespace Bitrix\\Main;\nclass Loader {}\n");
  await write(root, "bitrix/modules/iblock/lib/iblock.php", "<?php\nnamespace Bitrix\\Iblock;\nclass Iblock {}\n");
  await write(root, "bitrix/modules/main/install/index.php", "<?php\nclass main_install {}\n");
  await write(root, "bitrix/modules/main/lang/ru/lib/loader.php", "<?php\n$MESS['X'] = 'y';\n");
  await write(root, "bitrix/js/main/core/core.js", "export class Core {}\n");
  await write(root, "bitrix/cache/stale.php", "<?php\n");
  await write(root, "docs/guide.md", "# Guide\n\nHello.\n");
  return resolveRuntimePaths({
    workspaceRoot: root,
    dataDir: path.join(root, ".bitrix-mcp"),
    bitrixRoot: root,
    docsDir: path.join(root, "docs"),
    docsPaths: [path.join(root, "docs")],
    officialDocsEnabled: false
  });
}

function keys(targets: ReindexTarget[]): string[] {
  return targets.map((target) => target.key);
}

test("WatchScopeMapper maps changed paths to index scopes and directories", async () => {
  const paths = await makeWorkspace();
  const root = paths.workspaceRoot;
  const mapper = await WatchScopeMapper.create(paths, { modules: ["main"], docs: true }, paths.docsPaths);
  const at = (relativePath: string, isDirectory = false) => keys(mapper.classify(path.join(root, relativePath), isDirectory));

  assert.deepEqual(at("index.php"), ["project"]);
  assert.deepEqual(at("local/php_interface/init.php"), ["project"]);
  assert.deepEqual(at("local/templates/main/header.php"), ["template:local/templates/main"]);
  assert.deepEqual(at("local/templates/main/components/bitrix/news.list/.default/template.php"), ["template:local/templates/main"]);
  assert.deepEqual(at("local/components/acme/list/class.php"), ["template:local/components/acme/list"]);
  assert.deepEqual(at("bitrix/modules/main/lib/loader.php"), ["bitrix:bitrix/modules/main"]);
  assert.deepEqual(at("bitrix/js/main/core/core.js"), ["bitrix:bitrix/js/main"]);
  assert.deepEqual(at("bitrix/admin/index.php"), ["bitrix:bitrix/admin"]);
  assert.deepEqual(at("docs/guide.md"), ["docs", "project"]);

  // Not indexed by any scope.
  assert.deepEqual(at("bitrix/modules/iblock/lib/iblock.php"), [], "module outside --modules selection");
  assert.deepEqual(at("bitrix/modules/main/install/index.php"), [], "install assets need --install");
  assert.deepEqual(at("bitrix/modules/main/lang/ru/lib/loader.php"), [], "lang files need --include-lang");
  assert.deepEqual(at("bitrix/cache/stale.php"), []);
  assert.deepEqual(at("node_modules/pkg/index.js"), []);
  assert.deepEqual(at(".bitrix-mcp/bitrix-mcp.sqlite"), []);
  assert.deepEqual(at(".git/HEAD"), []);
  assert.deepEqual(at("image.png"), []);
  assert.deepEqual(at("bitrix/.settings.php"), []);

  // Directories (created, moved, or deleted).
  assert.deepEqual(at("local/templates/main", true), ["template:local/templates/main"]);
  assert.deepEqual(at("local/templates", true), ["template"]);
  assert.deepEqual(at("bitrix", true), ["template", "bitrix"]);

  assert.equal(mapper.shouldWatchDirectory(path.join(root, "bitrix/cache")), false);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, "bitrix/modules/iblock")), false);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, "bitrix/modules/main")), true);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, "bitrix/modules/main/install")), false);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, "local/templates/main")), true);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, ".bitrix-mcp")), false);
  assert.equal(mapper.shouldWatchDirectory(path.join(root, "node_modules")), false);

  const withInstall = await WatchScopeMapper.create(paths, { includeInstall: true, includeLang: true });
  assert.deepEqual(keys(withInstall.classify(path.join(root, "bitrix/modules/main/install/index.php"))), ["install:bitrix/modules/main/install"]);
  assert.deepEqual(keys(withInstall.classify(path.join(root, "bitrix/modules/main/install/js/main/x.js"))), [], "install/js is indexed under bitrix/js");
  assert.deepEqual(keys(withInstall.classify(path.join(root, "bitrix/modules/main/lang/ru/lib/loader.php"))), ["bitrix:bitrix/modules/main"]);

  const noBitrix = await WatchScopeMapper.create(paths, { noBitrix: true });
  assert.deepEqual(keys(noBitrix.classify(path.join(root, "bitrix/modules/main/lib/loader.php"))), []);
  assert.deepEqual(noBitrix.scopes(), ["project", "template"]);
});

test("WatchScopeMapper honors the root .gitignore for project and template files", async () => {
  const paths = await makeWorkspace();
  await write(paths.workspaceRoot, ".gitignore", "generated-*.php\n/local/templates/other/\n");
  const mapper = await WatchScopeMapper.create(paths);
  assert.deepEqual(mapper.classify(path.join(paths.workspaceRoot, "generated-a.php")), []);
  assert.deepEqual(mapper.classify(path.join(paths.workspaceRoot, "local/templates/other/footer.php")), []);
  assert.deepEqual(keys(mapper.classify(path.join(paths.workspaceRoot, ".gitignore"))), ["project", "template"]);
});

test("mergeReindexTargets lets whole-scope and parent-directory runs absorb nested ones", () => {
  const target = (scope: ReindexTarget["scope"], subPath?: string): ReindexTarget => ({ scope, key: subPath ? `${scope}:${subPath}` : scope, subPath });
  const merged = mergeReindexTargets([
    target("docs"),
    target("template", "local/templates/main"),
    target("bitrix", "bitrix/modules/main"),
    target("template"),
    target("bitrix", "bitrix/js/main"),
    target("bitrix", "bitrix/js"),
    target("project"),
    target("project")
  ]);
  assert.deepEqual(keys(merged), ["project", "template", "bitrix:bitrix/js", "bitrix:bitrix/modules/main", "docs"]);
});

async function waitFor<T>(events: WatchEvent[], predicate: (event: WatchEvent) => event is WatchEvent & T, timeoutMs = 10_000): Promise<WatchEvent & T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for a watch event; got ${JSON.stringify(events)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Reindex = Extract<WatchEvent, { event: "reindex" }>;
const reindexOf = (scope: string, subPath?: string) => (event: WatchEvent): event is Reindex =>
  event.event === "reindex" && event.scope === scope && event.path === subPath;

async function symbolNames(paths: RuntimePaths, kind: "project" | "template" | "bitrix"): Promise<string[]> {
  const manifest = await readIndexFromSqlite(sqlitePath(paths.dataDir), kind);
  return manifest?.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)) ?? [];
}

for (const mode of ["tree", "native"] as const) {
  test(`startWatch (${mode}) re-indexes changed project, template, and Bitrix files`, async () => {
    const paths = await makeWorkspace();
    await indexCode(paths, {});
    const templateFilesBefore = (await readIndexFromSqlite(sqlitePath(paths.dataDir), "template"))?.files.length ?? 0;
    const events: WatchEvent[] = [];
    const handle = await startWatch(paths, { mode, debounceMs: 50, onEvent: (event) => events.push(event) });
    try {
      const ready = events.find((event) => event.event === "ready");
      assert.ok(ready && ready.event === "ready");
      assert.deepEqual(ready.scopes, ["project", "template", "bitrix"]);
      if (mode === "tree") assert.ok(ready.directories > 5);

      await write(paths.workspaceRoot, "index.php", "<?php\nfunction project_home() {}\nfunction project_added() {}\n");
      const project = await waitFor(events, reindexOf("project"));
      assert.deepEqual(project.changed, ["index.php"]);
      assert.equal(project.parsedFiles, 1);
      assert.ok((await symbolNames(paths, "project")).includes("project_added"));

      await write(paths.workspaceRoot, "local/templates/main/footer.php", "<?php\nfunction main_footer() {}\n");
      const template = await waitFor(events, reindexOf("template", "local/templates/main"));
      assert.equal(template.parsedFiles, 1);
      const templateSymbols = await symbolNames(paths, "template");
      assert.ok(templateSymbols.includes("main_footer"));
      // Only the changed template directory was scanned; the others stay indexed.
      assert.ok(templateSymbols.includes("other_footer"));
      assert.ok(templateSymbols.includes("AcmeListComponent"));
      assert.equal((await readIndexFromSqlite(sqlitePath(paths.dataDir), "template"))?.files.length, templateFilesBefore + 1);

      await write(paths.workspaceRoot, "bitrix/modules/main/lib/application.php", "<?php\nnamespace Bitrix\\Main;\nclass Application {}\n");
      await waitFor(events, reindexOf("bitrix", "bitrix/modules/main"));
      const bitrixSymbols = await symbolNames(paths, "bitrix");
      assert.ok(bitrixSymbols.includes("Bitrix\\Main\\Application"));
      assert.ok(bitrixSymbols.includes("Bitrix\\Iblock\\Iblock"), "other modules are untouched");

      events.length = 0;
      await fs.rm(path.join(paths.workspaceRoot, "local/templates/other"), { recursive: true });
      await waitFor(events, (event): event is Reindex => event.event === "reindex" && event.scope === "template");
      await handle.idle();
      const afterDelete = await symbolNames(paths, "template");
      assert.ok(!afterDelete.includes("other_footer"), "deleted template is pruned");
      assert.ok(afterDelete.includes("main_footer"));

      events.length = 0;
      await write(paths.workspaceRoot, "bitrix/cache/new.php", "<?php\nfunction cached() {}\n");
      await write(paths.workspaceRoot, ".bitrix-mcp/scratch.php", "<?php\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await handle.idle();
      assert.deepEqual(events.filter((event) => event.event === "reindex"), [], "ignored paths trigger nothing");
    } finally {
      await handle.stop();
    }
    assert.equal(events.at(-1)?.event, "stopped");
  });
}

test("startWatch --docs re-indexes documentation changes", async () => {
  const paths = await makeWorkspace();
  await indexAll(paths, { noBitrix: true });
  const events: WatchEvent[] = [];
  const handle = await startWatch(paths, { noBitrix: true, docs: true, debounceMs: 50, onEvent: (event) => events.push(event) });
  try {
    await write(paths.workspaceRoot, "docs/new-page.md", "# New page\n\nWatch me.\n");
    const docs = await waitFor(events, reindexOf("docs"));
    assert.deepEqual(docs.changed, ["docs/new-page.md"]);
    assert.ok((docs.docChunks ?? 0) >= 2);
    assert.match(formatWatchEvent(docs), /docs: docs\/new-page\.md -> \d+ doc chunks/);
  } finally {
    await handle.stop();
  }
});
