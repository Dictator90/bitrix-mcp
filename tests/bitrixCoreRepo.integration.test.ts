import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createMcpServer } from "../src/mcp/server.js";
import { sqlitePath, type RuntimePaths } from "../src/config/paths.js";

const execFileAsync = promisify(execFile);
const bitrixCoreRepositoryUrl = "https://github.com/autrobin/bitrix.core.git";

type ToolResponse = { content: Array<{ type: string; text: string }> };
type ToolRegistry = Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolResponse> }>;

async function cloneBitrixCoreRepository(targetDir: string): Promise<string> {
  const checkoutDir = path.join(targetDir, "bitrix.core");
  await execFileAsync("git", ["clone", "--depth", "1", "--filter=blob:none", bitrixCoreRepositoryUrl, checkoutDir], { maxBuffer: 1024 * 1024 * 10 });
  return checkoutDir;
}

async function createStandardArchive(workDir: string): Promise<string> {
  const payloadDir = path.join(workDir, "standard-payload");
  const archivePath = path.join(workDir, "start_encode_php5.tar.gz");

  await fs.mkdir(path.join(payloadDir, "bitrix/modules/main/lib"), { recursive: true });
  await fs.mkdir(path.join(payloadDir, "bitrix/modules/main/install/js/standard"), { recursive: true });
  await fs.mkdir(path.join(payloadDir, "bitrix/modules/catalog/lib"), { recursive: true });

  await fs.writeFile(
    path.join(payloadDir, "bitrix/modules/main/include.php"),
    `<?php
function bitrix_standard_bootstrap(): void {}
class BitrixStandardHandler
{
    public static function onBeforeProlog(): void {}
}
AddEventHandler('main', 'OnBeforeProlog', ['BitrixStandardHandler', 'onBeforeProlog']);
define('BITRIX_STANDARD_FIXTURE', true);
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(payloadDir, "bitrix/modules/main/lib/application.php"),
    `<?php
namespace Bitrix\\Main;
class Application
{
    public function runStandardKernel(): void {}
}
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(payloadDir, "bitrix/modules/catalog/lib/product.php"),
    `<?php
namespace Bitrix\\Catalog;
class ProductTable
{
    public static function getList(array $parameters = []): array { return $parameters; }
}
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(payloadDir, "bitrix/modules/main/install/js/standard/admin.ts"),
    `export class StandardAdminPanel {
  render(): string { return 'standard'; }
}
export const standardHelpers = { prepare(): string { return 'ready'; } };
`,
    "utf8"
  );

  await execFileAsync("tar", ["-czf", archivePath, "-C", payloadDir, "."], { maxBuffer: 1024 * 1024 * 10 });
  return archivePath;
}

async function installStandardFromRepositoryUpdater(repoDir: string, archivePath: string): Promise<string> {
  const standardRoot = path.join(repoDir, "bitrix.start");
  const fakeBin = path.join(repoDir, ".test-bin");
  const fakeWget = path.join(fakeBin, "wget");

  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(fakeWget, "#!/bin/sh\ncp \"$BITRIX_MCP_STANDARD_ARCHIVE\" \"$PWD/start_encode_php5.tar.gz\"\n", "utf8");
  await fs.chmod(fakeWget, 0o755);

  await execFileAsync("sh", ["update.sh"], {
    cwd: standardRoot,
    env: { ...process.env, BITRIX_MCP_STANDARD_ARCHIVE: archivePath, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
    maxBuffer: 1024 * 1024 * 10
  });

  await fs.mkdir(path.join(standardRoot, "local/templates/standard/components/bitrix/news.list/.default"), { recursive: true });
  await fs.writeFile(
    path.join(standardRoot, "local/templates/standard/components/bitrix/news.list/.default/template.php"),
    "<?php\nfunction standard_template_helper(): void {}\n$APPLICATION->IncludeComponent('bitrix:news.detail', '', []);\n",
    "utf8"
  );
  await fs.mkdir(path.join(standardRoot, "docs/framework"), { recursive: true });
  await fs.writeFile(path.join(standardRoot, "docs/framework/standard.md"), "# Standard Bitrix\nmanaged cache standard repository deployment\n", "utf8");

  return standardRoot;
}

function parseJsonTool<T>(response: ToolResponse): T {
  return JSON.parse(response.content[0]?.text ?? "null") as T;
}

test("MCP tools index and search a standard Bitrix checkout deployed from autrobin/bitrix.core", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-core-repo-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-core-data-"));
  const repoDir = await cloneBitrixCoreRepository(workDir);
  const updater = await fs.readFile(path.join(repoDir, "bitrix.start/update.sh"), "utf8");
  assert.match(updater, /start_encode_php5\.tar\.gz/);

  const standardArchive = await createStandardArchive(workDir);
  const standardRoot = await installStandardFromRepositoryUpdater(repoDir, standardArchive);

  const paths: RuntimePaths = {
    workspaceRoot: standardRoot,
    dataDir,
    docsDir: path.join(standardRoot, "docs"),
    docsPaths: [path.join(standardRoot, "docs")],
    bitrixRoot: standardRoot,
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false
  };
  const server = createMcpServer(paths);
  const tools = (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;

  const allResult = await tools.bitrix_index_all.handler({});
  assert.match(allResult.content[0]?.text ?? "", /Indexed Bitrix module files: 3/);
  assert.match(allResult.content[0]?.text ?? "", /Indexed install asset files: 1/);
  assert.match(allResult.content[0]?.text ?? "", /Indexed documentation chunks: 1/);

  const projectResult = await tools.bitrix_index_project.handler({});
  assert.match(projectResult.content[0]?.text ?? "", /Indexed \d+ project files\./);

  const templateResult = await tools.bitrix_index_template.handler({ templatePath: "local/templates/standard" });
  assert.equal(templateResult.content[0]?.text, "Indexed 1 template files.");

  const docsResult = await tools.bitrix_index_docs.handler({});
  assert.equal(docsResult.content[0]?.text, "Indexed 1 documentation chunks.");

  const classSearch = parseJsonTool<Array<{ item: { name: string; module?: string; file: string } }>>(
    await tools.bitrix_liveapi_search.handler({ query: "Application", type: "class", module: "main", limit: 5 })
  );
  assert.equal(classSearch[0]?.item.name, "Bitrix\\Main\\Application");
  assert.ok(classSearch[0]?.item.file.startsWith(path.join(standardRoot, "bitrix/modules/main")));

  const installSearch = parseJsonTool<Array<{ item: { name: string; language?: string; module?: string } }>>(
    await tools.bitrix_liveapi_search.handler({ query: "StandardAdminPanel", type: "class", module: "main", limit: 5 })
  );
  assert.equal(installSearch[0]?.item.name, "StandardAdminPanel");
  assert.equal(installSearch[0]?.item.language, "typescript");

  const eventSearch = parseJsonTool<Array<{ item: { eventName: string; handlerClass?: string; handlerMethod?: string } }>>(
    await tools.bitrix_event_search.handler({ query: "BeforeProlog", module: "main", limit: 5 })
  );
  assert.equal(eventSearch[0]?.item.eventName, "OnBeforeProlog");
  assert.equal(eventSearch[0]?.item.handlerClass, "BitrixStandardHandler");
  assert.equal(eventSearch[0]?.item.handlerMethod, "onBeforeProlog");

  const docsSearch = parseJsonTool<Array<{ item: { text: string } }>>(
    await tools.bitrix_docs_search.handler({ query: "standard repository deployment", limit: 5 })
  );
  assert.match(docsSearch[0]?.item.text ?? "", /standard repository deployment/);

  const status = parseJsonTool<{ dbFile: string; files: number; symbols: number; events: number; documents: number }>(
    await tools.bitrix_index_status.handler({})
  );
  assert.equal(status.dbFile, sqlitePath(dataDir));
  assert.ok(status.files >= 6);
  assert.ok(status.symbols >= 9);
  assert.equal(status.events, 1);
  assert.equal(status.documents, 1);

  const resources = (server as unknown as {
    _registeredResources: Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>;
    _registeredResourceTemplates: Record<string, {
      readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }>;
    }>;
  });
  const indexResource = await resources._registeredResources["bitrix-docs://index"].readCallback(new URL("bitrix-docs://index"));
  assert.match(indexResource.contents[0]?.text ?? "", /standard\.md/);
  const indexedDocs = JSON.parse(indexResource.contents[0]?.text ?? "[]") as Array<{ uri: string }>;
  const docUri = indexedDocs.find((resource) => resource.uri.endsWith("standard.md"))?.uri;
  assert.ok(docUri);

  const docResource = await resources._registeredResourceTemplates["bitrix-docs"].readCallback(new URL(docUri));
  assert.match(docResource.contents[0]?.text ?? "", /managed cache standard/);
});
