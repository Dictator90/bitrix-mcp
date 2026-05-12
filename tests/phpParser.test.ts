import test from "node:test";
import assert from "node:assert/strict";
import { parsePhpModuleUsages, parsePhpSymbols, parsePhpSymbolsWithDiagnostics } from "../src/liveapi/phpParser.js";

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

test("parsePhpSymbols extracts Bitrix CAgent registrations", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
CAgent::AddAgent(
    "\\Vendor\\Module\\Agent::run();",
    "vendor.module",
    "N",
    86400
);
CAgent::AddAgent("vendor_agent_run();", "vendor.module", "Y", 60);
CAgent::RemoveAgent("vendor_agent_run();", "vendor.module");
CAgent::GetList([], []);
CAgent::AddAgent($dynamicName, $dynamicModule, $periodic, $interval);
`, "/srv/site/local/modules/vendor.module/install/index.php");

  const agents = symbols.filter((symbol) => symbol.type === "agent");
  assert.equal(agents.length, 5);

  const staticAgent = agents.find((agent) => agent.name === "\\Vendor\\Module\\Agent::run");
  assert.equal(staticAgent?.module, "vendor.module");
  assert.equal(staticAgent?.periodic, "N");
  assert.equal(staticAgent?.interval, 86400);
  assert.equal(staticAgent?.agentAction, "AddAgent");

  const functionAgent = agents.find((agent) => agent.name === "vendor_agent_run");
  assert.equal(functionAgent?.module, "vendor.module");
  assert.equal(functionAgent?.periodic, "Y");
  assert.equal(functionAgent?.interval, 60);

  assert.ok(agents.some((agent) => agent.agentAction === "RemoveAgent" && agent.name === "vendor_agent_run"));
  assert.ok(agents.some((agent) => agent.agentAction === "GetList"));
  assert.ok(agents.some((agent) => agent.agentAction === "AddAgent" && agent.name === "CAgent::AddAgent"));
});

test("parsePhpSymbols extracts Bitrix mail event sending calls", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
CEvent::Send('SALE_NEW_ORDER', SITE_ID, $fields);
CEvent::SendImmediate('SALE_STATUS_CHANGED', 's1', $fields);
\CEvent::Send('SALE_CANCEL_ORDER', 's2', $fields);
\Bitrix\Main\Mail\Event::send([
    'EVENT_NAME' => 'SALE_DELIVERY',
    'LID' => 's3',
    'C_FIELDS' => ['ID' => 1],
]);
CEvent::Send($dynamicEvent, SITE_ID, $fields);
`, "/srv/site/local/modules/vendor.module/lib/mail.php");

  const mailEvents = symbols.filter((symbol) => symbol.type === "mail_event");
  assert.equal(mailEvents.length, 5);
  assert.deepEqual(mailEvents.map((symbol) => symbol.eventName), ["SALE_NEW_ORDER", "SALE_STATUS_CHANGED", "SALE_CANCEL_ORDER", "SALE_DELIVERY", undefined]);
  assert.equal(mailEvents[0].siteId, "SITE_ID");
  assert.equal(mailEvents[0].api, "CEvent::Send");
  assert.equal(mailEvents[1].api, "CEvent::SendImmediate");
  assert.equal(mailEvents[1].siteId, "s1");
  assert.equal(mailEvents[3].api, "Bitrix\\Main\\Mail\\Event::send");
  assert.equal(mailEvents[3].siteId, "s3");
  assert.equal(mailEvents[4].name, "CEvent::Send");
});

test("parsePhpSymbols extracts mail-related event handlers", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
AddEventHandler('main', 'OnBeforeEventSend', ['MailHandlers', 'beforeSend']);
\Bitrix\Main\EventManager::getInstance()->addEventHandler('main', 'OnBeforeEventAdd', 'beforeEventAdd');
`, "/srv/site/local/php_interface/init.php");

  const beforeSend = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnBeforeEventSend");
  assert.equal(beforeSend?.module, "main");
  assert.equal(beforeSend?.handlerClass, "MailHandlers");
  assert.equal(beforeSend?.handlerMethod, "beforeSend");

  const beforeAdd = symbols.find((symbol) => symbol.type === "event" && symbol.eventName === "OnBeforeEventAdd");
  assert.equal(beforeAdd?.handlerFunction, "beforeEventAdd");
});

test("parsePhpSymbolsWithDiagnostics extracts D7 ORM entities and usages", () => {
  const { ormEntities, ormUsages } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Module;
use Bitrix\Main\ORM\Data\DataManager;
use Bitrix\Main\ORM\Fields\IntegerField;
use Bitrix\Main\ORM\Fields\StringField;
use Bitrix\Main\ORM\Fields\Relations\Reference;
class ProductTable extends DataManager
{
    public static function getTableName()
    {
        return 'vendor_product';
    }
    public static function getMap()
    {
        return [
            new IntegerField('ID', ['primary' => true, 'autocomplete' => true, 'title' => 'ID']),
            new StringField('NAME', ['required' => true, 'default_value' => 'New']),
            new ReferenceField('USER', UserTable::class, ['=this.USER_ID' => 'ref.ID']),
        ];
    }
}
ProductTable::getList([]);
\Bitrix\Main\Entity::compileEntity('Tmp', []);
`, "/srv/site/local/modules/vendor.module/lib/product.php");

  assert.equal(ormEntities.length, 1);
  assert.equal(ormEntities[0].className, "Vendor\\Module\\ProductTable");
  assert.equal(ormEntities[0].parentClass, "Bitrix\\Main\\ORM\\Data\\DataManager");
  assert.equal(ormEntities[0].tableName, "vendor_product");
  assert.equal(ormEntities[0].module, "vendor.module");
  assert.equal(ormEntities[0].fields.length, 3);
  assert.equal(ormEntities[0].fields[0].name, "ID");
  assert.equal(ormEntities[0].fields[0].options?.primary, true);
  assert.equal(ormEntities[0].fields[1].options?.required, true);
  assert.equal(ormEntities[0].references[0].name, "USER");
  assert.equal(ormEntities[0].references[0].referenceClass, "Vendor\\Module\\UserTable");
  assert.ok(ormUsages.some((usage) => usage.entity === "Vendor\\Module\\ProductTable" && usage.method === "getList"));
  assert.ok(ormUsages.some((usage) => usage.entity === "Bitrix\\Main\\Entity" && usage.usageKind === "compile_entity"));
});

test("parsePhpSymbolsWithDiagnostics detects legacy and imported DataManager parents", () => {
  const imported = parsePhpSymbolsWithDiagnostics(String.raw`<?php
use Bitrix\Main\Entity\DataManager as BaseDataManager;
class ImportedTable extends BaseDataManager { public static function getTableName(){ return 'imported'; } }
`, "/srv/site/local/modules/vendor.module/lib/imported.php");
  assert.equal(imported.ormEntities[0].className, "ImportedTable");
  assert.equal(imported.ormEntities[0].parentClass, "Bitrix\\Main\\Entity\\DataManager");

  const fq = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Module;
class LegacyTable extends \Bitrix\Main\Entity\DataManager { public static function getTableName(){ return 'legacy'; } }
`, "/srv/site/local/modules/vendor.module/lib/legacy.php");
  assert.equal(fq.ormEntities[0].className, "Vendor\\Module\\LegacyTable");
  assert.equal(fq.ormEntities[0].tableName, "legacy");
});

test("parsePhpSymbols extracts IncludeComponent templates and literal params", () => {
  const symbols = parsePhpSymbols(String.raw`<?php
$APPLICATION->IncludeComponent(
    "bitrix:catalog.section",
    ".default",
    [
      "IBLOCK_ID" => 17,
      "CACHE_TYPE" => "A",
      "CACHE_TIME" => '3600',
      "SEF_MODE" => $sefMode,
      "AJAX_MODE" => "N",
    ]
);
$APPLICATION->IncludeComponent('vendor:demo', '', ['IBLOCK_ID' => $dynamicIblock]);
`, "/srv/site/index.php").filter((symbol) => symbol.type === "component");

  const catalog = symbols.find((symbol) => symbol.name === "bitrix:catalog.section");
  assert.equal(catalog?.template, ".default");
  assert.deepEqual(catalog?.params, [
    { name: "IBLOCK_ID", value: 17 },
    { name: "CACHE_TYPE", value: "A" },
    { name: "CACHE_TIME", value: "3600" },
    { name: "SEF_MODE", value: "unknown" },
    { name: "AJAX_MODE", value: "N" }
  ]);

  const demo = symbols.find((symbol) => symbol.name === "vendor:demo");
  assert.equal(demo?.template, ".default");
  assert.deepEqual(demo?.params, [{ name: "IBLOCK_ID", value: "unknown" }]);
});

test("parsePhpSymbolsWithDiagnostics extracts common IBlock usages", () => {
  const result = parsePhpSymbolsWithDiagnostics(String.raw`<?php
class CatalogReader {
    public function load($iblockId) {
        CIBlockElement::GetList([], ["IBLOCK_ID" => 12]);
        CIBlockElement::GetList([], ['IBLOCK_ID' => CATALOG_IBLOCK_ID]);
        CIBlockSection::GetList([], ['IBLOCK_ID' => NEWS_IBLOCK_ID]);
        CIBlockElement::SetPropertyValuesEx($id, $iblockId, ['COLOR' => 'red']);
        \Bitrix\Iblock\ElementTable::getList(['filter' => ['IBLOCK_ID' => $iblockId]]);
    }
}
`, "/srv/site/local/php_interface/iblock.php");

  assert.deepEqual(result.iblockUsages.map((usage) => [usage.api, usage.iblockId]), [
    ["CIBlockElement::GetList", "12"],
    ["CIBlockElement::GetList", "CATALOG_IBLOCK_ID"],
    ["CIBlockSection::GetList", "NEWS_IBLOCK_ID"],
    ["CIBlockElement::SetPropertyValuesEx", "unknown"],
    ["Bitrix\\Iblock\\ElementTable::getList", "$iblockId"]
  ]);
  assert.ok(result.iblockUsages.every((usage) => usage.contextName === "CatalogReader::load"));
});
