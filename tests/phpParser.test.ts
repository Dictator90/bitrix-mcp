import test from "node:test";
import assert from "node:assert/strict";
import { parsePhpModuleUsages, parsePhpSymbols } from "../src/liveapi/phpParser.js";

const php = `<?php
class Example { public function run(): void {} }
define('EXAMPLE_CONST', 1);
AddEventHandler('main', 'OnPageStart', 'handler');
$APPLICATION->IncludeComponent('bitrix:news', '', []);
`;

test("parsePhpSymbols extracts Bitrix-oriented symbols", () => {
  const symbols = parsePhpSymbols(php, "/srv/site/bitrix/modules/main/lib/example.php");
  assert.equal(symbols.find((symbol) => symbol.type === "class")?.name, "Example");
  assert.equal(symbols.find((symbol) => symbol.type === "method")?.name, "run");
  assert.equal(symbols.find((symbol) => symbol.type === "constant")?.name, "EXAMPLE_CONST");
  assert.equal(symbols.find((symbol) => symbol.type === "event")?.name, "main:OnPageStart");
  assert.equal(symbols.find((symbol) => symbol.type === "component")?.name, "bitrix:news");
});

test("parsePhpSymbols extracts old core event handler variants", () => {
  const symbols = parsePhpSymbols(`<?php
AddEventHandler('main', 'OnBeforeProlog', ['LegacyHandlers', 'beforeProlog']);
RegisterModuleDependences('sale', 'OnSaleOrderSaved', 'custom.module', 'SaleHandlers', 'onSaved');
`, "/srv/site/local/php_interface/init.php");

  const addEventHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnBeforeProlog");
  assert.equal(addEventHandler?.module, "main");
  assert.equal(addEventHandler?.handlerClass, "LegacyHandlers");
  assert.equal(addEventHandler?.handlerMethod, "beforeProlog");
  assert.equal(addEventHandler?.line, 2);

  const registerModuleDependences = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnSaleOrderSaved");
  assert.equal(registerModuleDependences?.name, "sale:OnSaleOrderSaved");
  assert.equal(registerModuleDependences?.module, "sale");
  assert.equal(registerModuleDependences?.handlerClass, "SaleHandlers");
  assert.equal(registerModuleDependences?.handlerMethod, "onSaved");
  assert.equal(registerModuleDependences?.line, 3);
});

test("parsePhpSymbols extracts D7 EventManager handler variants", () => {
  const symbols = parsePhpSymbols(`<?php
\\Bitrix\\Main\\EventManager::getInstance()->addEventHandler('iblock', 'OnAfterIBlockElementAdd', 'onElementAdd');
EventManager::getInstance()->addEventHandlerCompatible('main', 'OnPageStart', ['D7Handlers', 'onPageStart']);
\\Bitrix\\Main\\EventManager::getInstance()->registerEventHandler(
    'crm',
    'OnAfterCrmDealAdd',
    'custom.module',
    'CrmHandlers',
    'onDealAdd'
);
`, "/srv/site/local/modules/custom.module/lib/events.php");

  const functionHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnAfterIBlockElementAdd");
  assert.equal(functionHandler?.module, "iblock");
  assert.equal(functionHandler?.handlerFunction, "onElementAdd");
  assert.equal(functionHandler?.line, 2);

  const compatibleHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnPageStart");
  assert.equal(compatibleHandler?.module, "main");
  assert.equal(compatibleHandler?.handlerClass, "D7Handlers");
  assert.equal(compatibleHandler?.handlerMethod, "onPageStart");
  assert.equal(compatibleHandler?.line, 3);

  const registeredHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnAfterCrmDealAdd");
  assert.equal(registeredHandler?.name, "crm:OnAfterCrmDealAdd");
  assert.equal(registeredHandler?.module, "crm");
  assert.equal(registeredHandler?.handlerClass, "CrmHandlers");
  assert.equal(registeredHandler?.handlerMethod, "onDealAdd");
  assert.equal(registeredHandler?.line, 4);
});

test("parsePhpSymbols extracts namespaced classes, aliases, calls, and typed method signatures", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
namespace Vendor\Module;

use App\Contracts\Runnable;
use App\Support\Worker as SupportWorker;

interface Runner extends Runnable {}
trait LogsWork {}
class Example
{
    public const STATUS_READY = 'ready';

    public function run(int $id, ?string $name = null): SupportWorker
    {
        SupportWorker::boot($id);
        $this->log($name);
    }
}
`, "/srv/site/local/modules/custom.module/lib/example.php");

  assert.equal(symbols.find((symbol) => symbol.type === "interface")?.name, "Vendor\\Module\\Runner");
  assert.equal(symbols.find((symbol) => symbol.type === "trait")?.name, "Vendor\\Module\\LogsWork");
  assert.equal(symbols.find((symbol) => symbol.type === "class")?.name, "Vendor\\Module\\Example");

  const method = symbols.find((symbol) => symbol.type === "method" && symbol.name === "run");
  assert.equal(method?.className, "Vendor\\Module\\Example");
  assert.match(method?.signature ?? "", /public function run\(int \$id, \?string \$name = null\): SupportWorker/);

  const constant = symbols.find((symbol) => symbol.type === "constant" && symbol.name.endsWith("::STATUS_READY"));
  assert.equal(constant?.name, "Vendor\\Module\\Example::STATUS_READY");

  const staticCall = symbols.find((symbol) => symbol.type === "static_call" && symbol.name.endsWith("::boot"));
  assert.equal(staticCall?.name, "App\\Support\\Worker::boot");

  const methodCall = symbols.find((symbol) => symbol.type === "method_call" && symbol.name === "$this->log");
  assert.equal(methodCall?.line, 16);
});

test("parsePhpSymbols extracts multiline EventManager calls with ::class handlers", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
namespace Vendor\Module;

use Bitrix\Main\EventManager;
use Vendor\Module\Handlers\PageHandler;

EventManager::getInstance()
    ->addEventHandlerCompatible(
        'main',
        'OnPageStart',
        [PageHandler::class, 'handle']
    );

\Bitrix\Main\EventManager::getInstance()->registerEventHandler(
    'sale',
    'OnSaleOrderSaved',
    'vendor.module',
    PageHandler::class,
    'onSaleOrderSaved'
);
`, "/srv/site/local/modules/vendor.module/lib/events.php");

  const compatibleHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnPageStart");
  assert.equal(compatibleHandler?.module, "main");
  assert.equal(compatibleHandler?.handlerClass, "Vendor\\Module\\Handlers\\PageHandler");
  assert.equal(compatibleHandler?.handlerMethod, "handle");
  assert.equal(compatibleHandler?.line, 7);

  const registeredHandler = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnSaleOrderSaved");
  assert.equal(registeredHandler?.module, "sale");
  assert.equal(registeredHandler?.handlerClass, "Vendor\\Module\\Handlers\\PageHandler");
  assert.equal(registeredHandler?.handlerMethod, "onSaleOrderSaved");
  assert.equal(registeredHandler?.line, 14);

  const eventManagerCall = symbols.find((symbol) => symbol.type === "static_call" && symbol.name === "Bitrix\\Main\\EventManager::getInstance");
  assert.ok(eventManagerCall);
});

test("parsePhpSymbols handles all Bitrix event callback styles", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
AddEventHandler('main', 'OnFunctionString', 'plain_handler');
AddEventHandler('main', 'OnArrayString', ['Vendor\\Module\\ArrayHandler', 'handle']);
AddEventHandler('main', 'OnClassConstantArray', [SomeClass::class, 'methodName']);
AddEventHandler('main', 'OnStaticString', '\\Vendor\\Module\\Handler::onEvent');
AddEventHandler('main', 'OnLegacyArray', array('Vendor\\Module\\LegacyHandler', 'onEvent'));
AddEventHandler('main', 'OnClosure', function () {
    return ['commas, stay', ['nested' => true]];
});
`, "/srv/site/local/php_interface/init.php");

  const byEvent = new Map(symbols.filter((symbol) => symbol.type === "event").map((symbol) => [symbol.eventName, symbol]));

  assert.equal(byEvent.get("OnFunctionString")?.handlerFunction, "plain_handler");
  assert.equal(byEvent.get("OnArrayString")?.handlerClass, "Vendor\\Module\\ArrayHandler");
  assert.equal(byEvent.get("OnArrayString")?.handlerMethod, "handle");
  assert.equal(byEvent.get("OnClassConstantArray")?.handlerClass, "SomeClass");
  assert.equal(byEvent.get("OnClassConstantArray")?.handlerMethod, "methodName");
  assert.equal(byEvent.get("OnStaticString")?.handlerClass, "\\Vendor\\Module\\Handler");
  assert.equal(byEvent.get("OnStaticString")?.handlerMethod, "onEvent");
  assert.equal(byEvent.get("OnLegacyArray")?.handlerClass, "Vendor\\Module\\LegacyHandler");
  assert.equal(byEvent.get("OnLegacyArray")?.handlerMethod, "onEvent");
  assert.equal(byEvent.get("OnClosure")?.handlerFunction, "closure");
  assert.equal(byEvent.get("OnClosure")?.anonymous, true);
});

test("parsePhpSymbols handles D7 EventManager chains and Windows module paths", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
class WindowsPathHandler {}
EventManager::getInstance()->addEventHandler(
    'main',
    'OnBeforeProlog',
    [Handler::class, 'onBeforeProlog']
);
\Bitrix\Main\EventManager::getInstance()->addEventHandlerCompatible(
    'sale',
    'OnSaleOrderSaved',
    ['Vendor\\Module\\Handler', 'onSaleOrderSaved']
);
RegisterModuleDependences('catalog', 'OnProductUpdate', 'vendor.module', 'Vendor\\Module\\CatalogHandler', 'onProductUpdate');
`, String.raw`C:\site\local\modules\vendor.module\lib\events.php`);

  const beforeProlog = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnBeforeProlog");
  assert.equal(beforeProlog?.module, "main");
  assert.equal(beforeProlog?.handlerClass, "Handler");
  assert.equal(beforeProlog?.handlerMethod, "onBeforeProlog");

  const saleSaved = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnSaleOrderSaved");
  assert.equal(saleSaved?.module, "sale");
  assert.equal(saleSaved?.handlerClass, "Vendor\\Module\\Handler");
  assert.equal(saleSaved?.handlerMethod, "onSaleOrderSaved");

  const productUpdate = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnProductUpdate");
  assert.equal(productUpdate?.module, "catalog");
  assert.equal(productUpdate?.handlerClass, "Vendor\\Module\\CatalogHandler");
  assert.equal(productUpdate?.handlerMethod, "onProductUpdate");

  const classSymbol = symbols.find((symbol) => symbol.type === "class");
  assert.equal(classSymbol?.module, "vendor.module");
});

test("parsePhpModuleUsages extracts Bitrix module include and check APIs", () => {
  const usages = parsePhpModuleUsages(String.raw`<?php
Loader::includeModule('iblock');
\Bitrix\Main\Loader::includeModule('sale');
CModule::IncludeModule('catalog');
IsModuleInstalled('sale');
ModuleManager::isModuleInstalled('iblock');
\Bitrix\Main\ModuleManager::isModuleInstalled('iblock');
Loader::includeModule($dynamicModule);
`, "/srv/site/local/php_interface/init.php");

  assert.deepEqual(usages.map((usage) => [usage.module, usage.call, usage.line, usage.signature]), [
    ["iblock", "Loader::includeModule", 2, "Loader::includeModule('iblock')"],
    ["sale", "Loader::includeModule", 3, "\\Bitrix\\Main\\Loader::includeModule('sale')"],
    ["catalog", "CModule::IncludeModule", 4, "CModule::IncludeModule('catalog')"],
    ["sale", "IsModuleInstalled", 5, "IsModuleInstalled('sale')"],
    ["iblock", "ModuleManager::isModuleInstalled", 6, "ModuleManager::isModuleInstalled('iblock')"],
    ["iblock", "ModuleManager::isModuleInstalled", 7, "\\Bitrix\\Main\\ModuleManager::isModuleInstalled('iblock')"]
  ]);
});
