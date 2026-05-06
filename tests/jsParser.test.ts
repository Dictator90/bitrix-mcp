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
