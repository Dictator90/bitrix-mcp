/** Bitrix API tables and helpers shared by the AST and regex PHP parsers. */

export type OptionApi = { api: string; operation: "get" | "set" };

const IBLOCK_APIS = new Map<string, string>([
  ["ciblockelement::getlist", "CIBlockElement::GetList"],
  ["ciblockelement::getbyid", "CIBlockElement::GetByID"],
  ["ciblockelement::setpropertyvaluesex", "CIBlockElement::SetPropertyValuesEx"],
  ["ciblockelement::add", "CIBlockElement::Add"],
  ["ciblockelement::update", "CIBlockElement::Update"],
  ["ciblocksection::getlist", "CIBlockSection::GetList"],
  ["ciblocksection::add", "CIBlockSection::Add"],
  ["ciblocksection::update", "CIBlockSection::Update"],
  ["ciblockpropertyenum::getlist", "CIBlockPropertyEnum::GetList"],
  ["bitrix\\iblock\\elementtable::getlist", "Bitrix\\Iblock\\ElementTable::getList"],
  ["bitrix\\iblock\\sectiontable::getlist", "Bitrix\\Iblock\\SectionTable::getList"]
]);

const HLBLOCK_APIS = new Map<string, string>([
  ["highloadblocktable::getlist", "HighloadBlockTable::getList"],
  ["highloadblocktable::getbyid", "HighloadBlockTable::getById"],
  ["highloadblocktable::compileentity", "HighloadBlockTable::compileEntity"],
  ["bitrix\\highloadblock\\highloadblocktable::getlist", "HighloadBlockTable::getList"],
  ["bitrix\\highloadblock\\highloadblocktable::getbyid", "HighloadBlockTable::getById"],
  ["bitrix\\highloadblock\\highloadblocktable::compileentity", "HighloadBlockTable::compileEntity"]
]);

const OPTION_APIS = new Map<string, OptionApi>([
  ["option::get", { api: "Option::get", operation: "get" }],
  ["option::set", { api: "Option::set", operation: "set" }],
  ["bitrix\\main\\config\\option::get", { api: "Bitrix\\Main\\Config\\Option::get", operation: "get" }],
  ["bitrix\\main\\config\\option::set", { api: "Bitrix\\Main\\Config\\Option::set", operation: "set" }],
  ["coption::getoptionstring", { api: "COption::GetOptionString", operation: "get" }],
  ["coption::setoptionstring", { api: "COption::SetOptionString", operation: "set" }],
  ["coption::getoptionint", { api: "COption::GetOptionInt", operation: "get" }],
  ["coption::setoptionint", { api: "COption::SetOptionInt", operation: "set" }]
]);

function apiKey(className: string, methodName: string): string {
  return `${className.replace(/^\\/u, "").toLowerCase()}::${methodName.toLowerCase()}`;
}

export function normalizeIblockApi(className: string, methodName: string): string | undefined {
  return IBLOCK_APIS.get(apiKey(className, methodName));
}

export function normalizeHlblockApi(className: string, methodName: string): string | undefined {
  return HLBLOCK_APIS.get(apiKey(className, methodName));
}

export function normalizeOptionApi(className: string, methodName: string): OptionApi | undefined {
  return OPTION_APIS.get(apiKey(className, methodName));
}

/** Normalizes a CAgent::AddAgent callable string (`Foo::bar();`) to `Foo::bar`, or undefined for non-callables. */
export function normalizeAgentName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const callable = value.trim().replace(/\s*;\s*$/u, "").replace(/\s*\(\s*\)\s*$/u, "").trim();
  if (/^\\?[A-Za-z_][A-Za-z0-9_\\]*::[A-Za-z_][A-Za-z0-9_]*$/u.test(callable)) return callable;
  if (/^\\?[A-Za-z_][A-Za-z0-9_\\]*$/u.test(callable)) return callable;
  return undefined;
}

let cachedSource: string | undefined;
let cachedLineStarts: number[] = [];

/** 1-based line number of `index` in `source`; newline offsets are cached for the last source seen. */
export function lineOf(source: string, index: number): number {
  if (source !== cachedSource) {
    cachedLineStarts = [];
    for (let position = source.indexOf("\n"); position >= 0; position = source.indexOf("\n", position + 1)) cachedLineStarts.push(position);
    cachedSource = source;
  }
  let low = 0;
  let high = cachedLineStarts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cachedLineStarts[middle] < index) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}
