import test from "node:test";
import assert from "node:assert/strict";
import { lineOf } from "../src/liveapi/bitrixApis.js";
import { parsePhpEvents } from "../src/liveapi/eventParser.js";
import { phpDocSummary } from "../src/liveapi/phpAstParser.js";
import { parsePhpSymbolsWithDiagnostics } from "../src/liveapi/phpParser.js";

const MODULE_FILE = "/srv/site/local/modules/vendor.mod/lib/probe.php";

test("AST walk reaches calls nested in arrays, new arguments, and lookups", () => {
  const result = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Bitrix\Main\Config\Option;
$x = ['x' => \CIBlockElement::GetList([], ['IBLOCK_ID' => 5])];
$y = new Foo(Option::get('main', 'zzz'));
$z = ['h' => \Bitrix\Highloadblock\HighloadBlockTable::getById(7)];
$w = (new Bar(\CIBlockSection::GetList([], ['IBLOCK_ID' => 9])))->run();
`, MODULE_FILE);

  assert.deepEqual(result.iblockUsages.map((usage) => [usage.api, usage.iblockId, usage.line]), [
    ["CIBlockElement::GetList", "5", 4],
    ["CIBlockSection::GetList", "9", 7]
  ]);
  assert.deepEqual(result.hlblockUsages.map((usage) => [usage.api, usage.hlblockId]), [["HighloadBlockTable::getById", "7"]]);
  const option = result.optionUsages.find((usage) => usage.name === "zzz");
  assert.equal(option?.module, "main");
  assert.equal(option?.line, 5);
  // Each call is recorded once even though the walk is now generic.
  assert.equal(result.symbols.filter((symbol) => symbol.type === "static_call" && symbol.name === "CIBlockElement::GetList").length, 1);
  assert.deepEqual(result.warnings, []);
});

test("syntax errors keep the partial AST and add a recovered warning", () => {
  const result = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Bitrix\Main\ORM\Data\DataManager;
class GoodTable extends DataManager {
  public static function getTableName() { return 'b_good'; }
  public function broken() { $x = ; }
}
function after() {}
`, MODULE_FILE);

  const names = result.symbols.filter((symbol) => symbol.type === "class" || symbol.type === "function").map((symbol) => symbol.name);
  assert.deepEqual(names, ["Vendor\\Mod\\GoodTable", "Vendor\\Mod\\after"]);
  assert.equal(result.ormEntities[0]?.className, "Vendor\\Mod\\GoodTable");
  assert.equal(result.ormEntities[0]?.tableName, "b_good");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].type, "php_parse_fallback");
  assert.equal(result.warnings[0].recovered, true);
  assert.match(result.warnings[0].message, /Recovered partial AST after 2 parse errors/);
});

test("partial AST is supplemented with regex-found handlers it skipped", () => {
  const result = parsePhpSymbolsWithDiagnostics("<?php\nclass Broken { public function run( {\nAddEventHandler('main', 'OnPageStart', 'fallbackHandler');\n", MODULE_FILE);
  assert.equal(result.warnings[0]?.recovered, true);
  assert.equal(result.symbols.filter((symbol) => symbol.type === "event" && symbol.eventName === "OnPageStart").length, 1);
  assert.ok(result.symbols.some((symbol) => symbol.type === "class" && symbol.name === "Broken"));
});

test("an unterminated attribute at EOF does not hang the parser", () => {
  const result = parsePhpSymbolsWithDiagnostics("<?php\nclass Hanging {\n  #[\\Deprecated}    public function run() {}\n  \n", MODULE_FILE);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.symbols.some((symbol) => symbol.type === "class" && symbol.name === "Hanging"));
});

test("a truncated enum declaration at EOF does not hang the parser", () => {
  for (const source of ["<?php\nenum", "<?php\nenum Status", "<?php\nenum Status: string"]) {
    const result = parsePhpSymbolsWithDiagnostics(source, MODULE_FILE);
    assert.equal(result.warnings.length, 1, source);
  }
});

test("PHP 8.4 property hooks parse without falling back", () => {
  const result = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
class Person {
  public string $name { get => strtoupper($this->name); set(string $value) { $this->name = $value; } }
  public function greet(): string { return \Bitrix\Main\Config\Option::get('vendor.mod', 'greeting'); }
}
`, MODULE_FILE);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.symbols.some((symbol) => symbol.type === "method" && symbol.fullyQualifiedName === "Vendor\\Mod\\Person::greet"));
  assert.equal(result.optionUsages[0]?.name, "greeting");
});

test("enums, enum cases, interface extends, and attributes are indexed", () => {
  const { symbols } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Vendor\Mod\Contracts\HasLabel;

#[\Attribute(\Attribute::TARGET_CLASS)]
enum Status: string implements HasLabel
{
    case Active = 'A';
    case Blocked = 'B';
    const DEFAULT = self::Active;
    public function label(): string { return $this->value; }
}

interface Repository extends Countable, \IteratorAggregate {}

#[Route('/x')]
final class Controller {}
`, MODULE_FILE);

  const enumSymbol = symbols.find((symbol) => symbol.type === "enum");
  assert.equal(enumSymbol?.name, "Vendor\\Mod\\Status");
  assert.deepEqual(enumSymbol?.implements, ["Vendor\\Mod\\Contracts\\HasLabel"]);
  assert.deepEqual(enumSymbol?.attributes, ["Attribute"]);
  assert.equal(enumSymbol?.signature, "enum Status: string implements HasLabel");
  const constants = symbols.filter((symbol) => symbol.type === "constant").map((symbol) => symbol.name);
  assert.deepEqual(constants, ["Vendor\\Mod\\Status::Active", "Vendor\\Mod\\Status::Blocked", "Vendor\\Mod\\Status::DEFAULT"]);
  assert.equal(symbols.find((symbol) => symbol.type === "method" && symbol.name === "label")?.className, "Vendor\\Mod\\Status");

  const repository = symbols.find((symbol) => symbol.type === "interface");
  assert.equal(repository?.extends, "Vendor\\Mod\\Countable");
  assert.deepEqual(repository?.implements, ["IteratorAggregate"]);

  assert.deepEqual(symbols.find((symbol) => symbol.name === "Vendor\\Mod\\Controller")?.attributes, ["Vendor\\Mod\\Route"]);
});

test("PHPDoc summaries populate descriptions of classes, methods, and functions", () => {
  const { symbols } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
/**
 * Handles orders.
 * Second line of the summary.
 *
 * Longer description that is not part of the summary.
 * @package vendor.mod
 */
class OrderService
{
    /** Saves an order. */
    #[Pure]
    public function save() {}

    /**
     * @return void
     */
    public function tagsOnly() {}
}

/**
 * Global helper.
 */
function order_helper() {}
`, MODULE_FILE);
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  assert.equal(byName.get("OrderService")?.description, "Handles orders. Second line of the summary.");
  assert.equal(byName.get("save")?.description, "Saves an order.");
  assert.equal(byName.get("tagsOnly")?.description, undefined);
  assert.equal(byName.get("order_helper")?.description, "Global helper.");
  assert.equal(phpDocSummary(`/** ${"x".repeat(400)} */`)?.length, 300);
});

test("ORM entities: fluent fields, relations, legacy maps, $map variables, and Table subclasses", () => {
  const { ormEntities } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;

use Bitrix\Main\ORM\Data\DataManager;
use Bitrix\Main\ORM\Fields;
use Bitrix\Main\ORM\Fields\IntegerField;
use Bitrix\Main\ORM\Fields\Relations\Reference;
use Bitrix\Main\ORM\Fields\Relations\OneToMany;
use Bitrix\Main\ORM\Fields\Relations\ManyToMany;
use Bitrix\Main\ORM\Query\Join;

class OrderTable extends DataManager
{
    public static function getTableName() { return 'v_order'; }

    public static function getMap()
    {
        $map = [
            (new IntegerField('ID'))->configurePrimary()->configureAutocomplete(),
            new Fields\StringField('NAME', ['required' => true]),
        ];
        $map[] = (new Fields\StringField('STATUS'))->configureDefaultValue('N')->configureRequired(false);
        $map[] = new Reference('USER', \Bitrix\Main\UserTable::class, Join::on('this.USER_ID', 'ref.ID'));
        $map[] = new OneToMany('ITEMS', ItemTable::class, 'ORDER');
        $map[] = new ManyToMany('TAGS', TagTable::class);
        return $map;
    }
}

class LegacyTable extends \Bitrix\Main\Entity\DataManager
{
    public static function getMap()
    {
        return array(
            'ID' => array('data_type' => 'integer', 'primary' => true, 'autocomplete' => true),
            'USER' => array('data_type' => 'Bitrix\Main\User', 'reference' => array('=this.USER_ID' => 'ref.ID')),
            'CNT' => array('data_type' => 'integer', 'expression' => array('COUNT(%s)', 'ID')),
        );
    }
}

class ArchivedOrderTable extends OrderTable
{
    public static function getTableName() { return 'v_order_archive'; }
}

class NotAnEntity extends \Some\Base { public static function getList() {} }
`, MODULE_FILE);

  assert.deepEqual(ormEntities.map((entity) => [entity.className, entity.tableName ?? null]), [
    ["Vendor\\Mod\\OrderTable", "v_order"],
    ["Vendor\\Mod\\LegacyTable", null],
    ["Vendor\\Mod\\ArchivedOrderTable", "v_order_archive"]
  ]);

  const order = ormEntities[0];
  assert.deepEqual(order.fields.map((field) => [field.name, field.type, field.options ?? null]), [
    ["ID", "IntegerField", { primary: true, autocomplete: true }],
    ["NAME", "StringField", { required: true }],
    ["STATUS", "StringField", { default_value: "N", required: false }],
    ["USER", "Reference", null],
    ["ITEMS", "OneToMany", null],
    ["TAGS", "ManyToMany", null]
  ]);
  assert.equal(order.fields[1].className, "Bitrix\\Main\\ORM\\Fields\\StringField");
  assert.deepEqual(order.references.map((field) => [field.name, field.referenceClass]), [
    ["USER", "Bitrix\\Main\\UserTable"],
    ["ITEMS", "Vendor\\Mod\\ItemTable"],
    ["TAGS", "Vendor\\Mod\\TagTable"]
  ]);

  const legacy = ormEntities[1];
  assert.deepEqual(legacy.fields.map((field) => [field.name, field.type, field.referenceClass ?? null, field.options ?? null]), [
    ["ID", "IntegerField", null, { primary: true, autocomplete: true }],
    ["USER", "ReferenceField", "Bitrix\\Main\\User", null],
    ["CNT", "ExpressionField", null, null]
  ]);
  assert.deepEqual(legacy.references.map((field) => field.name), ["USER"]);
});

test("ORM usages are limited to Table classes and skip self/static/parent and legacy classes", () => {
  const { ormUsages } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Bitrix\Main\ORM\Data\DataManager;
class Order extends DataManager
{
    public static function getTableName() { return 'v_order'; }
    public static function sync()
    {
        self::getList([]);
        static::update(1, []);
        parent::delete(1);
        \CUser::Update(1, []);
        \CIBlockElement::GetList([], []);
        $entityClass::getList([]);
        ItemTable::getList([]);
        \Bitrix\Main\UserTable::getRow(['filter' => ['=ID' => 1]]);
        Order::getById(1);
    }
}
`, MODULE_FILE);
  assert.deepEqual(ormUsages.map((usage) => [usage.entity, usage.method]), [
    ["Vendor\\Mod\\ItemTable", "getList"],
    ["Bitrix\\Main\\UserTable", "getRow"],
    ["Vendor\\Mod\\Order", "getById"]
  ]);
});

test("event handlers resolve self/static/__CLASS__/$this and record unregistrations", () => {
  const { symbols } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Bitrix\Main\EventManager;
class Handlers extends BaseHandlers
{
    public function install()
    {
        $em = EventManager::getInstance();
        $em->addEventHandler('main', 'OnProlog', [self::class, 'onProlog']);
        $em->addEventHandler('main', 'OnEpilog', [static::class, 'onEpilog']);
        $em->addEventHandler('main', 'OnA', [__CLASS__, 'onA']);
        $em->addEventHandler('main', 'OnB', [$this, 'onB']);
        $em->addEventHandler('main', 'OnP', [parent::class, 'onP']);
        $em->registerEventHandlerCompatible('sale', 'OnC', 'vendor.mod', self::class, 'onC');
        $em->unRegisterEventHandler('sale', 'OnC', 'vendor.mod', self::class, 'onC');
        UnRegisterModuleDependences('sale', 'OnD', 'vendor.mod', 'Vendor\\Mod\\Legacy', 'onD');
    }
}
`, MODULE_FILE);
  const handlers = symbols.filter((symbol) => symbol.type === "event").map((symbol) => [symbol.name, symbol.handlerClass, symbol.handlerMethod]);
  assert.deepEqual(handlers, [
    ["main:OnProlog", "Vendor\\Mod\\Handlers", "onProlog"],
    ["main:OnEpilog", "Vendor\\Mod\\Handlers", "onEpilog"],
    ["main:OnA", "Vendor\\Mod\\Handlers", "onA"],
    ["main:OnB", "Vendor\\Mod\\Handlers", "onB"],
    ["main:OnP", "Vendor\\Mod\\BaseHandlers", "onP"],
    ["sale:OnC", "Vendor\\Mod\\Handlers", "onC"]
  ]);
  const unregistered = symbols.filter((symbol) => symbol.type === "event_unregister").map((symbol) => [symbol.name, symbol.module, symbol.eventName, symbol.handlerClass, symbol.handlerMethod, symbol.api]);
  assert.deepEqual(unregistered, [
    ["sale:OnC", "sale", "OnC", "Vendor\\Mod\\Handlers", "onC", "unRegisterEventHandler"],
    ["sale:OnD", "sale", "OnD", "Vendor\\Mod\\Legacy", "onD", "UnRegisterModuleDependences"]
  ]);
  assert.ok(symbols.some((symbol) => symbol.type === "static_call" && symbol.name === "Bitrix\\Main\\EventManager::getInstance"));
});

test("fired events are indexed as event_emit symbols", () => {
  const { symbols } = parsePhpSymbolsWithDiagnostics(String.raw`<?php
namespace Vendor\Mod;
use Bitrix\Main\Event;
use Bitrix\Main;
class Service
{
    public function save()
    {
        $event = new Event('vendor.mod', 'OnOrderSaved', ['id' => 1]);
        $event->send();
        (new Main\Event('vendor.mod', 'OnOrderChecked'))->send();
        foreach (GetModuleEvents('vendor.mod', 'OnLegacyOrder', true) as $arEvent) {
            ExecuteModuleEventEx($arEvent, [1]);
        }
        $handlers = Main\EventManager::getInstance()->findEventHandlers('vendor.mod', 'OnFind');
        $other = new \Other\Event('x', 'NotBitrix');
    }
}
function fire_global() { $e = new \Bitrix\Main\Event($moduleId, 'OnDynamicModule'); }
`, MODULE_FILE);
  const emits = symbols.filter((symbol) => symbol.type === "event_emit").map((symbol) => [symbol.name, symbol.module ?? null, symbol.eventName, symbol.api, symbol.className ?? null, symbol.description ?? null]);
  assert.deepEqual(emits, [
    ["vendor.mod:OnOrderSaved", "vendor.mod", "OnOrderSaved", "Bitrix\\Main\\Event", "Vendor\\Mod\\Service", "Fired in Vendor\\Mod\\Service::save"],
    ["vendor.mod:OnOrderChecked", "vendor.mod", "OnOrderChecked", "Bitrix\\Main\\Event", "Vendor\\Mod\\Service", "Fired in Vendor\\Mod\\Service::save"],
    ["vendor.mod:OnLegacyOrder", "vendor.mod", "OnLegacyOrder", "GetModuleEvents", "Vendor\\Mod\\Service", "Fired in Vendor\\Mod\\Service::save"],
    ["vendor.mod:OnFind", "vendor.mod", "OnFind", "EventManager::findEventHandlers", "Vendor\\Mod\\Service", "Fired in Vendor\\Mod\\Service::save"],
    ["OnDynamicModule", null, "OnDynamicModule", "Bitrix\\Main\\Event", null, "Fired in Vendor\\Mod\\fire_global"]
  ]);
  assert.equal(symbols.some((symbol) => symbol.type === "event"), false);
});

test("regex event fallback resolves self::class and registerEventHandlerCompatible", () => {
  const events = parsePhpEvents(String.raw`<?php
namespace Vendor\Mod;
class Handlers {
  public static function install() {
    EventManager::getInstance()->registerEventHandlerCompatible('main', 'OnProlog', 'vendor.mod', self::class, 'onProlog');
    AddEventHandler('main', 'OnEpilog', [__CLASS__, 'onEpilog']);
  }
}
`, MODULE_FILE);
  assert.deepEqual(events.map((event) => [event.eventName, event.handlerClass, event.handlerMethod]), [
    ["OnProlog", "Vendor\\Mod\\Handlers", "onProlog"],
    ["OnEpilog", "Vendor\\Mod\\Handlers", "onEpilog"]
  ]);
});

test("lineOf matches a naive newline count", () => {
  const source = "a\nb\r\nc\n\nd";
  for (let index = 0; index <= source.length; index += 1) {
    assert.equal(lineOf(source, index), source.slice(0, index).split(/\r?\n/).length, `index ${index}`);
  }
  assert.equal(lineOf("x", 0), 1);
});
