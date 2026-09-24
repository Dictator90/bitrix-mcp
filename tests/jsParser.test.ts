import test from "node:test";
import assert from "node:assert/strict";
import { parseJsSymbols } from "../src/liveapi/jsParser.js";

const tsSource = `
export class VendorWidget {
  render(): void {}
}

export function bootWidget(): void {}

export const helpers = {
  prepare() {
    return true;
  },
  finish: () => false
};

const internalApi = {
  ping() {
    return "pong";
  }
};

export { internalApi };
`;

test("parseJsSymbols extracts TS classes, methods, functions, exports, object methods, and install module", () => {
  const symbols = parseJsSymbols(tsSource, "/srv/site/local/modules/vendor.module/install/js/admin/widget.ts");

  const classSymbol = symbols.find((symbol) => symbol.type === "class" && symbol.name === "VendorWidget");
  assert.equal(classSymbol?.module, "vendor.module");
  assert.equal(classSymbol?.language, "typescript");

  const methodSymbol = symbols.find((symbol) => symbol.type === "method" && symbol.name === "render");
  assert.equal(methodSymbol?.className, "VendorWidget");

  assert.ok(symbols.some((symbol) => symbol.type === "function" && symbol.name === "bootWidget"));
  assert.ok(symbols.some((symbol) => symbol.type === "export" && symbol.name === "VendorWidget"));
  assert.ok(symbols.some((symbol) => symbol.type === "export" && symbol.name === "internalApi"));
  assert.ok(symbols.some((symbol) => symbol.type === "object_method" && symbol.name === "helpers.prepare"));
  assert.ok(symbols.some((symbol) => symbol.type === "object_method" && symbol.name === "helpers.finish"));
  assert.ok(symbols.some((symbol) => symbol.type === "object_method" && symbol.name === "internalApi.ping"));
});

test("parseJsSymbols extracts CommonJS exports from Bitrix install paths", () => {
  const symbols = parseJsSymbols(`
module.exports = {
  mount() {}
};
exports.unmount = function () {};
`, "/srv/site/bitrix/modules/main/install/js/panel.js");

  assert.ok(symbols.some((symbol) => symbol.type === "export" && symbol.name === "module.exports" && symbol.module === "main"));
  assert.ok(symbols.some((symbol) => symbol.type === "object_method" && symbol.name === "module.exports.mount"));
  assert.ok(symbols.some((symbol) => symbol.type === "export" && symbol.name === "unmount"));
  assert.ok(symbols.some((symbol) => symbol.type === "function" && symbol.name === "unmount"));
});

test("parseJsSymbols assigns modules to bitrix/js and non-install module paths", () => {
  const source = "export class Widget {}\n";
  assert.equal(parseJsSymbols(source, "/srv/site/bitrix/js/vendor.module/widget.js")[0]?.module, "vendor.module");
  assert.equal(parseJsSymbols(source, String.raw`C:\site\bitrix\js\main\core\core.js`)[0]?.module, "main");
  assert.equal(parseJsSymbols(source, "/srv/site/local/modules/vendor.module/assets/app.js")[0]?.module, "vendor.module");
  assert.equal(parseJsSymbols(source, "/srv/site/local/templates/main/script.js")[0]?.module, undefined);
});

test("parseJsSymbols records class extends and legacy BX declarations", () => {
  const symbols = parseJsSymbols(`
BX.namespace('BX.Vendor');
var ns = BX.namespace('BX.Vendor.Grid');
BX.Vendor.Popup = function (params) { this.onClose = function () {}; };
BX.Vendor.Popup.prototype.show = function () {};
ns.Row = function () {};
ns.Cell = class extends BX.Vendor.Base {};
class Dialog extends BX.Main.Popup {}
class Plain {}
`, "/srv/site/bitrix/js/vendor.module/popup.js");

  const byName = new Map(symbols.map((symbol) => [`${symbol.type}:${symbol.name}`, symbol]));
  assert.ok(byName.has("function:BX.Vendor.Popup"));
  assert.equal(byName.get("method:show")?.className, "BX.Vendor.Popup");
  assert.ok(byName.has("function:BX.Vendor.Grid.Row"));
  assert.equal(byName.get("class:BX.Vendor.Grid.Cell")?.extends, "BX.Vendor.Base");
  assert.equal(byName.get("class:Dialog")?.extends, "BX.Main.Popup");
  assert.equal(byName.get("class:Plain")?.extends, undefined);
  assert.equal(symbols.some((symbol) => symbol.name.includes("onClose")), false);
  assert.ok(symbols.every((symbol) => symbol.module === "vendor.module"));
});
