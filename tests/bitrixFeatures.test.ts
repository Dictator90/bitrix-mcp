import test from "node:test";
import assert from "node:assert/strict";
import { extractBitrixFeatures, extractJsBitrixFeatures, jsExtensionNameFromPath, type BitrixFeatureRecord } from "../src/liveapi/bitrixFeatures.js";

function pick(records: BitrixFeatureRecord[], type: BitrixFeatureRecord["featureType"]) {
  return records.filter((record) => record.featureType === type).map(({ name, target, module, detail }) => ({ name, target, module, detail }));
}

test("D7 controller actions from *Action methods and configureActions", () => {
  const records = extractBitrixFeatures(`<?php
namespace Vendor\\Shop\\Controller;
use Bitrix\\Main\\Engine\\Controller;
class Basket extends Controller {
  public function configureActions() { return ['add' => ['prefilters' => []], 'clear' => []]; }
  public function addAction(int $id) {}
  protected function hiddenAction() {}
  public function helper() {}
}
`, "local/modules/vendor.shop/lib/controller/basket.php");
  assert.deepEqual(pick(records, "controller_action").map((record) => [record.name, record.target, record.module]), [
    ["Vendor\\Shop\\Controller\\Basket::add", "Vendor\\Shop\\Controller\\Basket::addAction", "vendor.shop"],
    ["Vendor\\Shop\\Controller\\Basket::clear", "Vendor\\Shop\\Controller\\Basket::clearAction", "vendor.shop"]
  ]);
});

test("component class implementing Controllerable exposes its actions", () => {
  const records = extractBitrixFeatures(`<?php
use Bitrix\\Main\\Engine\\Contract\\Controllerable;
class FeedbackForm extends CBitrixComponent implements Controllerable {
  public function configureActions() { return ['send' => []]; }
  public function sendAction($text) {}
}
`, "local/components/vendor/feedback.form/class.php");
  assert.deepEqual(pick(records, "controller_action").map((record) => record.name), ["FeedbackForm::send"]);
});

test("routes with prefixes, groups, names and controller handlers", () => {
  const records = extractBitrixFeatures(`<?php
use Bitrix\\Main\\Routing\\RoutingConfigurator;
use Vendor\\Api\\Items;
return function (RoutingConfigurator $routes) {
  $routes->get('/health', fn () => 'ok');
  $routes->prefix('api')->group(function (RoutingConfigurator $routes) {
    $routes->get('items', [Items::class, 'list'])->name('items_list');
    $routes->post('/items/{id}', [Items::class, 'update']);
  });
};
`, "local/routes/web.php");
  assert.deepEqual(pick(records, "route").map((record) => [record.name, record.target, record.detail?.routeName]), [
    ["GET /health", "closure", undefined],
    ["GET /api/items", "Vendor\\Api\\Items::list", "items_list"],
    ["POST /api/items/{id}", "Vendor\\Api\\Items::update", undefined]
  ]);
});

test("urlrewrite rules, REST methods, lang phrases and usages", () => {
  const urlrewrite = extractBitrixFeatures(`<?php
$arUrlRewrite = array(
  array('CONDITION' => '#^/news/#', 'RULE' => '', 'ID' => 'bitrix:news', 'PATH' => '/news/index.php', 'SORT' => 100),
);
`, "urlrewrite.php");
  assert.deepEqual(pick(urlrewrite, "urlrewrite_rule").map((record) => [record.name, record.target, record.detail?.path]), [["#^/news/#", "bitrix:news", "/news/index.php"]]);

  const rest = extractBitrixFeatures(`<?php
namespace Vendor\\Crm;
class Rest {
  public static function onRestServiceBuildDescription() {
    return ['vendor.crm' => ['vendor.crm.deal.get' => [__CLASS__, 'get'], 'vendor.crm.deal.list' => ['callback' => [Rest::class, 'list'], 'options' => []]]];
  }
}
`, "local/modules/vendor.crm/lib/rest.php");
  assert.deepEqual(pick(rest, "rest_method").map((record) => [record.name, record.target]), [["vendor.crm.deal.get", "Vendor\\Crm\\Rest::get"], ["vendor.crm.deal.list", "Vendor\\Crm\\Rest::list"]]);

  const phrases = extractBitrixFeatures(`<?php\n$MESS["VENDOR_TITLE"] = "Заголовок";\n$MESS['VENDOR_EMPTY'] = '';\n`, "local/components/vendor/list/lang/ru/component.php");
  assert.deepEqual(pick(phrases, "lang_phrase").map((record) => [record.name, record.detail?.lang, record.detail?.text]), [["VENDOR_TITLE", "ru", "Заголовок"], ["VENDOR_EMPTY", "ru", ""]]);

  const usage = extractBitrixFeatures(`<?php
use Bitrix\\Main\\Localization\\Loc;
echo Loc::getMessage('VENDOR_TITLE');
echo GetMessage("VENDOR_OLD");
`, "local/components/vendor/list/component.php");
  assert.deepEqual(pick(usage, "lang_usage").map((record) => record.name), ["VENDOR_TITLE", "VENDOR_OLD"]);
});

test("JS extensions, autoload registration, user fields, iblock properties and component metadata", () => {
  assert.equal(jsExtensionNameFromPath("bitrix/js/ui/buttons/config.php"), "ui.buttons");
  assert.equal(jsExtensionNameFromPath("local/js/vendor/widget/config.php"), "vendor.widget");
  const extension = extractBitrixFeatures(`<?php\nreturn ['js' => 'dist/widget.bundle.js', 'css' => 'dist/widget.bundle.css', 'rel' => ['main.core', 'ui.buttons']];\n`, "local/js/vendor/widget/config.php");
  assert.deepEqual(pick(extension, "js_extension")[0], { name: "vendor.widget", target: undefined, module: undefined, detail: { js: "dist/widget.bundle.js", css: "dist/widget.bundle.css", rel: ["main.core", "ui.buttons"] } });

  const include = extractBitrixFeatures(`<?php
use Bitrix\\Main\\Loader;
use Bitrix\\Main\\UI\\Extension;
Loader::registerAutoLoadClasses('vendor.shop', ['\\\\Vendor\\\\Shop\\\\Helper' => 'lib/helper.php']);
Loader::registerNamespace('Vendor\\\\Shop', __DIR__ . '/lib');
Extension::load(['vendor.widget', 'ui.buttons']);
CJSCore::Init('jquery');
$fields = ['ENTITY_ID' => 'USER', 'FIELD_NAME' => 'UF_LOYALTY', 'USER_TYPE_ID' => 'integer'];
(new CUserTypeEntity())->Add($fields);
(new CIBlockProperty())->Add(['IBLOCK_ID' => 5, 'CODE' => 'BRAND', 'PROPERTY_TYPE' => 'S', 'NAME' => 'Brand']);
`, "local/modules/vendor.shop/include.php");
  assert.deepEqual(pick(include, "autoload_class").map((record) => [record.name, record.target, record.module]), [["Vendor\\Shop\\Helper", "lib/helper.php", "vendor.shop"]]);
  assert.deepEqual(pick(include, "autoload_namespace").map((record) => record.name), ["Vendor\\Shop"]);
  assert.deepEqual(pick(include, "js_extension_usage").map((record) => record.name), ["vendor.widget", "ui.buttons", "jquery"]);
  assert.deepEqual(pick(include, "user_field").map((record) => [record.name, record.detail?.entityId]), [["UF_LOYALTY", "USER"]]);
  assert.deepEqual(pick(include, "iblock_property").map((record) => [record.name, record.detail?.iblockId, record.detail?.type]), [["BRAND", 5, "S"]]);

  const parameters = extractBitrixFeatures(`<?php
$arComponentParameters = ['PARAMETERS' => ['IBLOCK_ID' => ['PARENT' => 'BASE', 'NAME' => 'Инфоблок', 'TYPE' => 'LIST'], 'CACHE_TIME' => ['DEFAULT' => 3600]]];
`, "local/components/vendor/list/.parameters.php");
  assert.deepEqual(pick(parameters, "component_parameter").map((record) => [record.name, record.detail?.type]), [["IBLOCK_ID", "LIST"], ["CACHE_TIME", undefined]]);
  const description = extractBitrixFeatures(`<?php\n$arComponentDescription = ['NAME' => 'Vendor list', 'DESCRIPTION' => 'Lists items', 'PATH' => ['ID' => 'vendor']];\n`, "local/components/vendor/list/.description.php");
  assert.equal(pick(description, "component_description")[0]?.name, "Vendor list");
});

test("broken PHP yields no features instead of throwing", () => {
  assert.deepEqual(extractBitrixFeatures("<?php class {", "broken.php"), []);
});

test("JS AJAX action calls and custom events", () => {
  const records = extractJsBitrixFeatures([
    "BX.ajax.runAction('vendor:shop.basket.add', { data: { id: 1 } });",
    "BX.ajax.runComponentAction(\"vendor:feedback.form\", 'send', { mode: 'class' });",
    "BX.addCustomEvent('onAjaxSuccess', handler);",
    "BX.addCustomEvent(window, 'OnBasketChange', handler);",
    "BX.Event.EventEmitter.subscribe('BX.Main.Grid:paramsUpdated', fn);",
    "BX.onCustomEvent('OnBasketChange', [data]);"
  ].join("\n"));
  assert.deepEqual(records.map((record) => [record.featureType, record.name, record.line, record.detail?.role]), [
    ["ajax_call", "vendor:shop.basket.add", 1, undefined],
    ["ajax_call", "vendor:feedback.form::send", 2, undefined],
    ["js_event", "onAjaxSuccess", 3, "subscribe"],
    ["js_event", "OnBasketChange", 4, "subscribe"],
    ["js_event", "BX.Main.Grid:paramsUpdated", 5, "subscribe"],
    ["js_event", "OnBasketChange", 6, "emit"]
  ]);
});

test("indexing stores features and graph edges", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { buildIndex } = await import("../src/indexer/indexer.js");
  const { searchBitrixFeatures, searchBitrixRelations } = await import("../src/indexer/sqliteStore.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-features-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitrix-mcp-features-data-"));
  try {
    const write = async (file: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content, "utf8");
    };
    await write("local/routes/web.php", "<?php\nreturn function ($routes) { $routes->get('/items', [\\Vendor\\Api\\Items::class, 'list']); };\n");
    await write("local/js/acme/widget/config.php", "<?php\nreturn ['js' => 'widget.js', 'rel' => ['main.core']];\n");
    await write("local/js/acme/widget/widget.js", "BX.ajax.runAction('vendor:api.items.list');\n");
    const dbFile = path.join(dataDir, "bitrix-mcp.sqlite");
    // local/js belongs to the bitrix scope.
    await buildIndex({ root, kind: "bitrix", dbFile, patterns: ["local/**/*.{php,js}"] });

    const routes = await searchBitrixFeatures(dbFile, { featureType: "route" });
    assert.deepEqual(routes.map((route) => [route.name, route.target, route.relativeFile]), [["GET /items", "Vendor\\Api\\Items::list", "local/routes/web.php"]]);
    const ajax = await searchBitrixFeatures(dbFile, { query: "vendor:api.items" });
    assert.equal(ajax[0]?.featureType, "ajax_call");
    const edges = await searchBitrixRelations(dbFile, { sourceType: "route", sourceName: "GET /items" }) ?? [];
    assert.deepEqual(edges.map((edge) => [edge.relationType, edge.targetType, edge.targetName]), [["handled_by", "method", "Vendor\\Api\\Items::list"]]);
    const deps = await searchBitrixRelations(dbFile, { relationType: "depends_on_extension" }) ?? [];
    assert.deepEqual(deps.map((edge) => [edge.sourceName, edge.targetName]), [["acme.widget", "main.core"]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
