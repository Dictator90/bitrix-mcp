import test from "node:test";
import assert from "node:assert/strict";
import { parsePhpSymbols } from "../src/liveapi/phpParser.js";

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
