# Indexing

Bitrix MCP stores indexes in `.bitrix-mcp/bitrix-mcp.sqlite`. Use `bitrix-mcp index-all` or MCP `bitrix_index` with `scope: "all"` for project, template, Bitrix core, and docs (module install assets only with `--install` / `includeInstall: true`). Use a narrower command or scope when only one part changed: `index-project`, `index-template`, `index-bitrix`, `index-install`, `index-docs`, or `bitrix_index` with `scope` `project`, `template`, `bitrix`, `install`, or `docs`.

For the full command list, Bitrix core module selection, incremental reindex behavior, and progress options, see [cli.md](./cli.md). Reindexing is incremental — a file is re-parsed only when its size or mtime changed, or when it was indexed by an older parser version (each file records the parser version, so upgrading bitrix-mcp re-parses what the new parser reads differently without `--force`).

## How a run works

1. **Discover** the files of the scope.
2. **Prune** indexed files that no longer exist — only under the directory this run scanned. Re-indexing one template (`index-template local/templates/main`) or a custom project root leaves the rest of the scope alone, and its paths stay workspace-relative.
3. **Parse** changed files. Runs with 200+ changed files parse in worker threads (`BITRIX_MCP_INDEX_WORKERS`, default CPUs − 1, at most 4). A file that disappears or fails to parse becomes a `file_error` warning in `status` instead of aborting the run.
4. **Write** in transactions of 250 files, so searches keep working during a long run and memory stays bounded. Every connection waits up to 5 s for another writer's lock instead of failing with "database is locked", and MCP index tools run one at a time (parallel calls queue).

Method call sites (`Class::method()`, `$obj->method()`) are stored in a separate lean table: they no longer appear in `bitrix_liveapi_search` results, and `bitrix_explain_api_usage` uses them for "local usages".

The schema is migrated once per database when bitrix-mcp is upgraded (`PRAGMA user_version`); searches never run DDL.

`npm run benchmark` and `bitrix-mcp benchmark` generate `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md`. By default the benchmark uses incremental indexing and does not force a full reindex; pass `--force` only when you intentionally want cold/full timings. Missing Bitrix roots, docs, or optional indexes are reported as warnings instead of deleting data or failing the whole benchmark.

## Bitrix framework features

Besides classes, functions and events, indexing records Bitrix constructs that are not plain symbols. Find them with `bitrix_entity_search` (`entity: "feature"`, optional `featureType`); most also become graph edges.

| Feature | Source | Graph edge |
| --- | --- | --- |
| `controller_action` | public `*Action` methods and `configureActions()` of `Bitrix\Main\Engine\Controller`/`JsonController` subclasses and `Controllerable` components | action → `handled_by` → method |
| `route` | `routes/*.php` (`$routes->get/post/…`, `prefix`, `group`, `name`) | route → `handled_by` → method |
| `urlrewrite_rule` | `urlrewrite.php` | rule → `routes_to_component` → component |
| `rest_method` | arrays returned by `OnRestServiceBuildDescription` handlers | method → `handled_by` → handler |
| `lang_phrase` / `lang_usage` | `$MESS['KEY']` in `lang/` files; `Loc::getMessage` / `GetMessage` | file → `defines_phrase` / `uses_phrase` → phrase |
| `js_extension` / `js_extension_usage` | extension `config.php`, `CJSCore::RegisterExt`; `Extension::load`, `CJSCore::Init` | extension → `depends_on_extension` → extension; file → `loads_js_extension` |
| `autoload_class` / `autoload_namespace` | `Loader::registerAutoLoadClasses` / `registerNamespace` | module → `autoloads_class` / `autoloads_namespace` |
| `user_field` / `iblock_property` | UF field (`FIELD_NAME` + `ENTITY_ID`) and iblock property (`CODE` + `PROPERTY_TYPE` + `IBLOCK_ID`) definition arrays | file → `defines_user_field` / `defines_iblock_property` |
| `component_parameter` / `component_description` | `.parameters.php` / `.description.php` | component → `has_parameter` |
| `ajax_call` / `js_event` | `BX.ajax.runAction` / `runComponentAction`; `BX.addCustomEvent`, `EventEmitter.subscribe`/`emit`, `BX.onCustomEvent` | file → `calls_ajax_action` / `subscribes_js_event` / `emits_js_event` |

Fired PHP events (`new \Bitrix\Main\Event(...)`, `GetModuleEvents`, `EventManager::findEventHandlers`) are indexed as `event_emit` symbols with a class → `emits_event` → event edge, so traversing from an event reaches both its handlers and the code that fires it.

Project and template scopes index `lang/` directories so their phrases are searchable; the Bitrix core and install scopes still skip `lang/` unless `--include-lang` / `--full` is given.
