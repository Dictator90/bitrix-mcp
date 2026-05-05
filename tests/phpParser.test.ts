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
