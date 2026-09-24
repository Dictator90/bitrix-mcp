# MCP tools

This page documents the MCP tools, prompts, and completions implemented in `src/mcp/`. Every tool returns compact (single-line) JSON text; search and list tools also return the same object as `structuredContent` and declare an `outputSchema`. Examples below come from the test fixture project.

The server registers **17 tools** by default (up to 23 with semantic search, DB access, and tinker enabled). Every tool has a `title`, a description for each parameter, and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can auto-approve read-only calls.

Recommended AI workflow (also sent to clients as the server `instructions`):

- General project work: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_event_search` / `bitrix_entity_search` / `bitrix_docs_search` → `bitrix_read_symbol_context` or `bitrix_read_file_context`.
- Review work: `bitrix_detect_changes` (includes impact by default) → `bitrix_impact_radius` → `bitrix_graph_neighbors` / `bitrix_graph_traverse` → source context tools. The `review-changes` prompt runs this flow.
- Bitrix events: `bitrix_event_search` → `bitrix_entity_search` (`entity: "relation"`) → `bitrix_graph_neighbors` → `bitrix_read_file_context`. The `trace-event` prompt runs this flow.
- ORM: `bitrix_entity_search` (`entity: "orm_entity"`) → `bitrix_orm_entity_map` → `bitrix_entity_search` (`entity: "orm_usage"`) → `bitrix_graph_neighbors`.
- Components: `bitrix_entity_search` (`entity: "component"`) → `bitrix_component_context` → `bitrix_impact_radius` when changing component files.
- Live data (when `BITRIX_MCP_DB_ENABLED=1`): `bitrix_entity_search` (`iblock_usage` / `orm_entity`) in code → `bitrix_db_connections` → `bitrix_db_schema` → `bitrix_db_query` to inspect real rows.

## Tool results authority

Treat Bitrix MCP tool results as the primary source of truth for Bitrix Framework and project indexed data. Manual file search should be used as a fallback only when MCP tools return empty or stale results.

## Result envelope and pagination

`bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_entity_search`, `bitrix_docs_search`, `bitrix_docs_for_symbol`, `bitrix_orm_entity_map`, and `bitrix_semantic_docs_search` return one envelope:

```json
{"count":2,"truncated":true,"nextCursor":"eyJvIjoyfQ","results":[{"score":0.9,"type":"class","kind":"project","name":"DemoComponent","file":"index.php","line":2,"signature":"class DemoComponent"},{"score":0.9,"type":"class","kind":"template","name":"DemoComponent","file":"index.php","line":2,"signature":"class DemoComponent"}]}
```

- `count`: results on this page.
- `total`: exact number of results; present only when the last page was reached.
- `truncated`: `true` when more results exist than were returned. The server reads `limit + 1` rows, so a page that is exactly full at the end of the result set reports `truncated: false`.
- `nextCursor`: opaque cursor for the next page. Pass it back unchanged as `cursor` with the same query and `limit`.
- `results`: the rows (compact fields by default, raw indexed records with `format: "full"`).
- `entity` (`bitrix_entity_search` only) and `warnings` (ignored filters, pagination notes) when relevant.

Cursors reach the first 500 results of a query (100 for `bitrix_docs_for_symbol`). Past that window the envelope is `truncated: true` without `nextCursor` and has a warning; narrow the query with filters. An invalid cursor is a tool error.

## Tool reference

### `bitrix_index_status`
- Purpose: show SQLite path, index counters (with breakdowns by kind and language), and the last index time.
- Parameters: none.
- Example response: `{"dbFile":".bitrix-mcp/bitrix-mcp.sqlite","files":1200,"filesByKind":[{"label":"project","count":180},...],"symbols":9000,"events":45,"relations":3000,...,"lastIndexedAt":"2026-09-24T10:00:00.000Z"}`.
- Use when: starting any task or checking benchmark/index health.
- Limitations: counters are only as current as the last index run.

### `bitrix_project_overview`
- Purpose: summarize indexed project structure, top entities, autoload coverage, and warnings.
- Parameters: `includeTopFiles` (default `false`), `includeModules`, `includeComponents`, `includeEvents`, `includeOrm`, `includeAgents`, `includeMailEvents`, `includeWarnings` (all default `true`), `format`.
- Example response: `{"summary":{"files":1200,"components":34},"warnings":["no events found"],...}`.
- Use when: planning larger work.
- Limitations: overview is derived from SQLite indexes and may omit unindexed/generated code.

### `bitrix_index`
- Purpose: build the SQLite index for one scope. Incremental: unchanged files are skipped. Runs in its own worker with the heavy timeout, queues behind other index calls, and sends progress notifications when the client passes a progress token.
- Parameters:
  - `scope` (required): `project` (workspace code), `template` (templates, components, scripts, styles), `bitrix` (Bitrix core modules/admin/tools/js; needs the Bitrix root), `install` (module `install/` assets), `docs` (registered documentation sources; git sources are cloned/pulled), or `all` (project + template + bitrix + docs, plus install with `includeInstall`).
  - `root` (`project`): directory to index; must be inside the workspace unless `BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1`.
  - `templatePath` (`template`): template directory relative to the workspace, e.g. `local/templates/site`; absolute paths and `..` segments are refused by default.
  - `modules` (`bitrix`): core module ids, e.g. `["main", "iblock"]`; default all modules. Unknown modules are reported; none found is an error.
  - `includeInstall` (`all`): also index module `install/` assets (slow on a full core); default `false`.
- Example responses (text): `Indexed 4 project files.`, `Indexed 7 template files.`, `Indexed 12 documentation chunks.`; `scope: "all"` returns `Indexed project files: 180`, `Indexed template files: 75`, `Indexed Bitrix module files: 0`, `Indexed install asset files: 0`, `Indexed documentation chunks: 420`, `SQLite DB: …` on separate lines.
- Use when: initial setup, after local changes, or when a search is empty because an index is stale.
- Limitations: `docs`/`all` may need network for git documentation sources; `bitrix` fails without a Bitrix root, and `all` skips the core when it is absent. Lang files are not indexed from MCP (use the CLI `--include-lang`).

### `bitrix_liveapi_search`
- Purpose: search indexed symbols: classes, interfaces, traits, methods, functions, events, components, constants, mail events, and frontend exports. Exact and prefix name matches rank first, then weighted full-text relevance.
- Parameters: `query` (required); `type` (`class`, `interface`, `trait`, `function`, `method`, `event`, `component`, `constant`, `mail_event`), `module`, `kind` (`project`, `template`, `bitrix`, `install`, or an array), `preferLocal` (default `true`), `limit` (1–100, default 20), `cursor`, `includeSignature` (default `true`), `maxSignatureChars` (default 160), `format`.
- Example response: see [Result envelope](#result-envelope-and-pagination).
- Use when: looking for APIs or local symbols.
- Limitations: depends on indexed files and parser coverage.

### `bitrix_event_search`
- Purpose: search indexed event handlers by event name (`OnBeforeProlog` or `main:OnBeforeProlog`), handler class, method, or function.
- Parameters: `query` (required); `module`, `kind`, `preferLocal`, `limit` (1–100, default 20), `cursor`, `includeSignature`, `maxSignatureChars`, `format`.
- Example response: `{"count":2,"total":2,"truncated":false,"results":[{"score":1,"type":"event","kind":"project","name":"OnBeforeProlog","module":"main","file":"index.php","line":13,"signature":"AddEventHandler('main', 'OnBeforeProlog', ['Demo', 'handler']);"},...]}`.
- Use when: auditing event registrations.
- Limitations: only registrations detectable from indexed code are returned.

### `bitrix_entity_search`
- Purpose: one search tool for every indexed Bitrix entity type. Set `entity`, then the filters that entity supports; other filters are ignored and listed in `warnings`.
- Parameters: `entity` (required), the filters below, `limit` (1–100, default 20), `cursor`, `format`.

| `entity` | Searches | Filters |
|---|---|---|
| `agent` | `CAgent::AddAgent`/`RemoveAgent`/`GetList` calls | `query`, `module`, `kind`, `file` |
| `mail_event` | `CEvent::Send`/`SendImmediate`, `Event::send` calls | `query`, `eventName`, `api`, `kind`, `file`, `includeHandlers` (adds `OnBeforeEventSend`/`OnBeforeEventAdd` handlers) |
| `component` | `IncludeComponent` calls | `query`, `component`, `template`, `kind`, `file` |
| `module_usage` | `Loader::includeModule`, `CModule::IncludeModule`, module checks | `module`, `call`, `kind`, `file` |
| `iblock_usage` | IBlock API calls and `IBLOCK_ID` references | `query`, `iblockId`, `api`, `kind`, `file` |
| `hlblock_usage` | Highloadblock API calls | `query`, `hlblockId`, `api`, `kind`, `file` |
| `option` | `Option`/`COption` reads and writes | `query`, `module`, `name`, `operation` (`get`/`set`), `api`, `kind`, `file` |
| `orm_entity` | D7 ORM `DataManager` entities | `query`, `tableName`, `className`, `module`, `kind` |
| `orm_usage` | ORM calls (`getList`, `query`, `add`, `update`, `delete`, `compileEntity`) | `query`, `ormEntity`, `method`, `file`, `kind` |
| `autoload` | Composer autoload mappings, dependencies, classmaps, files, Bitrix bootstrap files | `query`, `namespace`, `package`, `autoloadType` (`psr-4`, `files`, `classmap`, `dependency`, `dev_dependency`, `bootstrap`) |
| `relation` | canonical `bitrix_relations` graph edges | `sourceType`, `sourceName`, `targetType`, `targetName`, `relationType`, `module`, `kind` (single; also `autoload`), `file` |
| `inheritance` | classes that extend, implement, or use a target | `target` (or `query`), `relation` (`extends`, `implements`, `uses_trait`, `any`), `kind`, `module`, `transitive`, `maxDepth` (1–10, default 5) |

  Node types (`sourceType`/`targetType`, graph tools): `file`, `module`, `event`, `method`, `function`, `class`, `component`, `template`, `agent`, `mail_event`, `iblock`, `hlblock`, `option`, `orm_entity`, `asset`, `namespace_prefix`, `package`, `directory`, `bootstrap`. Classes, interfaces, and traits are all `class`.
  Relation types: `registers_event_handler`, `handles_event`, `includes_module`, `registers_agent`, `removes_agent`, `queries_agents`, `calls_method`, `sends_mail_event`, `handles_mail_event`, `includes_component`, `uses_template`, `uses_asset`, `uses_iblock`, `uses_hlblock`, `uses_option`, `defines_option`, `defines_orm_entity`, `uses_orm_entity`, `references_orm_entity`, `extends`, `implements`, `uses_trait`, `autoloads_from`, `is_dependency`, `is_bootstrap`.
- Example responses:
  - `{"entity":"module_usage","module":"iblock"}` → `{"entity":"module_usage","count":1,"total":1,"truncated":false,"results":[{"module":"iblock","call":"Loader::includeModule","kind":"project","file":"local/php_interface/init.php","line":2,"signature":"\\Bitrix\\Main\\Loader::includeModule('iblock')"}]}`
  - `{"entity":"inheritance","target":"Controller"}` → `{"entity":"inheritance","count":1,"total":1,"truncated":false,"results":[{"className":"OrderHandler","relation":"extends","targetType":"class","targetName":"Bitrix\\Main\\Engine\\Controller","targetKind":"class","kind":"project","file":"local/php_interface/init.php","line":5,"signature":"class OrderHandler extends \\Bitrix\\Main\\Engine\\Controller"}]}`
  - `{"entity":"relation","targetType":"module","limit":1}` → `{"entity":"relation","count":1,"truncated":true,"nextCursor":"eyJvIjoxfQ","results":[{"source":"file:local/php_interface/init.php","target":"module:iblock","relationType":"includes_module","module":"iblock","kind":"project","file":"local/php_interface/init.php","line":2,"signature":"\\Bitrix\\Main\\Loader::includeModule('iblock')"}]}`
  - `{"entity":"agent","iblockId":"7"}` → `{"entity":"agent","count":0,"total":0,"truncated":false,"results":[],"warnings":["Ignored filters for entity=agent: iblockId. Supported: query, module, kind, file."]}`
- Use when: auditing agents, mail events, components, module/IBlock/Highloadblock/option usage, ORM, autoloading, graph edges, or class hierarchies.
- Limitations: dynamic names (agent strings, event names, IBlock ids, option names) are best-effort; `inheritance` without `target` is an error. See [graph](./graph.md) for how inheritance and relation lookups match names.

### `bitrix_docs_search`
- Purpose: SQLite FTS search across indexed documentation chunks (English porter and Russian Snowball stemming).
- Parameters: `query` (required); `limit` (1–50, default 5), `cursor`, `maxTextChars` (excerpt cap, default 500), `format`.
- Example response: `{"count":1,"truncated":true,"nextCursor":"eyJvIjoxfQ","results":[{"score":0.85,"type":"doc","title":"Framework Guide","uri":"bitrix-docs://path-1/framework/markdown-headings.md","headingPath":"Framework Guide > Caching > Managed Cache Details","sectionAnchor":"managed-cache-details","relativePath":"framework/markdown-headings.md","chunkIndex":10,"excerpt":"Heading path: Framework Guide > Caching > **Managed** **Cache** Details …"}]}`.
- Use when: needing local Bitrix docs without embeddings.
- Limitations: requires `bitrix_index` with `scope: "docs"` (or `all`); ranking is lexical.

### `bitrix_semantic_docs_search` *(optional)*
- Purpose: semantic documentation search through an embeddings service.
- Parameters: `query`, `limit` (1–20, default 5), `maxTextChars`, `format`.
- Example response: `{"count":1,"total":1,"truncated":false,"results":[{"score":0.82,"type":"doc","title":"Cache","uri":"bitrix-docs://...","excerpt":"..."}]}`.
- Use when: `BITRIX_MCP_SEMANTIC_ENABLED=1` and the embeddings service is running.
- Limitations: not registered unless semantic mode is enabled; not paginated (`truncated` says whether more matches exist).

### `bitrix_docs_for_symbol`
- Purpose: find doc chunks mentioning a specific API symbol.
- Parameters: `symbol` (required, case-insensitive exact match); `limit` (1–100, default 20), `cursor`, `format`.
- Example response: `{"count":1,"total":1,"truncated":false,"results":[{"title":"CIBlockElement::GetList","uri":"bitrix-docs://...","path":"...","chunkIndex":0,"excerpt":"... filters and selected fields ..."}]}`.
- Use when: moving from code symbol to documentation.
- Limitations: depends on doc symbol extraction during docs indexing.

### `bitrix_explain_api_usage`
- Purpose: combine docs, local usages, core definitions, relations, and deterministic recommendations for an API.
- Parameters: `query` (required); `kind` (local-usage kinds, default project/template/install), `includeDocs`, `includeLocalUsages`, `includeCoreDefinition` (all default `true`), `limit` (items per section, default 10), `format`.
- Example response: `{"query":"Loader::includeModule","docs":[],"localUsages":[],"coreDefinitions":[],"relations":[],"recommendations":["Check module availability before using module APIs."]}`.
- Use when: validating API usage before edits. The `explain-api` prompt starts here.
- Limitations: recommendations are deterministic summaries, not a replacement for official docs review.

### `bitrix_read_file_context`
- Purpose: read bounded numbered source lines from an allowed file.
- Parameters: `file`, `line` (required); `before` (default 5), `after` (default 20), `maxChars` (default 12000).
- Example response: `{"metadata":{"absolutePath":"/…/index.php","relativePath":"index.php","language":"php","startLine":6,"endLine":9,"totalLines":14,"truncated":false},"numberedLines":"6: \n7: function demo_helper(string $name): string\n..."}`.
- Use when: a search result points to a file/line.
- Limitations: reads only inside workspace or data directory allowlist; refuses credential/dump files (`.settings.php`, `dbconn.php`, `.env`, keys, SQL dumps, `bitrix/backup/`, … — see [security](./security.md)), binary files, and files over 10 MB.

### `bitrix_read_symbol_context`
- Purpose: resolve an indexed symbol and read source around its definition.
- Parameters: `name` (required); `type` (`class`, `interface`, `trait`, `function`, `method`, `event`, `component`, `constant`), `kind`, `file`, `before`, `after`, `includeBody` (default `false`), `maxChars`, `format`.
- Example response: `{"query":{"name":"DemoComponent","type":"class"},"ambiguous":false,"symbol":{"type":"class","name":"DemoComponent","kind":"project","file":"index.php","line":2,"lineEnd":5},"context":{"metadata":{…},"numberedLines":"2: class DemoComponent\n..."}}`.
- Use when: you know a symbol name but not the exact file/line.
- Limitations: ambiguous names return `candidates`; narrow by type, kind, or file.

### `bitrix_component_context`
- Purpose: return component calls, resolved template files/assets, params, and relations.
- Parameters: `component` (required); `template` (default `.default`), `callFile`, `includeFiles`, `includeAssets`, `includeParams` (all default `true`), `format`.
- Example response: `{"component":"bitrix:catalog.section","template":".default","calls":[…],"templateFiles":[{"file":"local/templates/…/template.php","kind":"template"}],"assets":[…],"parameters":[…]}`.
- Use when: assessing template impact.
- Limitations: resolution follows indexed template conventions and does not execute Bitrix runtime logic.

### `bitrix_orm_entity_map`
- Purpose: return `getMap()` fields and references for an entity.
- Parameters: `className`, `tableName`, `file`, `format`.
- Example response: `{"count":1,"total":1,"truncated":false,"results":[{"className":"Vendor\\Module\\ProductTable","tableName":"vendor_product","fields":[{"name":"ID","type":"integer"}],"references":[]}]}`.
- Use when: changing ORM queries or schema-dependent code.
- Limitations: complex computed maps may be incomplete.

### `bitrix_graph_neighbors`
- Purpose: return immediate or bounded-depth graph neighbors from `bitrix_relations`.
- Parameters: `nodeType`, `nodeName` (required; node types listed under `bitrix_entity_search`); `direction` (`out` default, `in`, `both`), `relationType`, `depth` (1–5, default 1), `limit` (default 100), `maxEdgesPerNode`, `format`.
- Example response: `{"node":{"type":"event","name":"main:OnBeforeProlog"},"neighbors":[{"type":"method","name":"Vendor\\Module\\Handler::run","relationType":"handles_event",…}],…}`.
- Use when: checking direct dependencies. The `trace-event` prompt uses it.
- Limitations: depth maximum is 5; see [graph](./graph.md) for bounds.

### `bitrix_graph_traverse`
- Purpose: cycle-safe BFS traversal of the Bitrix dependency graph.
- Parameters: `startType`, `startName` (required); `direction`, `maxDepth` (0–8, default 2), `relationTypes`, `limit` (default 100), `maxEdgesPerNode`, `format`.
- Example response: `{"nodes":[{"id":"file:local/php_interface/init.php","depth":0},{"id":"event:main:OnBeforeProlog","depth":1},…],"edges":[…],"truncated":false}`.
- Use when: exploring transitive dependencies.
- Limitations: bounded by depth and limit to avoid runaway traversals.

### `bitrix_impact_radius`
- Purpose: find likely impacted entities for changed files or a git diff.
- Parameters: `files`, `base` (default `HEAD~1`), `maxDepth` (0–8, default 2), `relationTypes`, `includeChangedSymbols`, `includeRisk`, `limit` (default 100), `maxEdgesPerNode`, `format`.
- Example response: `{"changedFiles":["local/php_interface/init.php"],"impacted":{"events":[…],"methods":[…]},"risk":{"score":7,"level":"low"}}`.
- Use when: reviewing changes before tests/deploy.
- Limitations: impact is graph-derived and should be validated with tests.

### `bitrix_detect_changes`
- Purpose: analyze git-changed (including untracked and deleted) files against the index: symbol-level diff, affected Bitrix entities, relations, graph impact, risk, and recommendations.
- Parameters: `base` (default `HEAD~1`), `kind` (`project`, `template`, `component`, `bitrix`, `install`, `docs`, `asset`, `unknown`, or an array), `includeSource`, `includeRelations`, `includeImpact`, `includeRisk`, `symbolDiff` (default `true`), `diffBaseline` (`auto`, `index`, `git`), `maxDepth`, `maxFiles`, `maxItems`, `format`. See [detect changes](./detect-changes.md).
- Example response: `{"summary":{"files":2,"symbols":5,"components":1,"relations":3},"symbolDiff":{…},"impact":{"truncated":false},"recommendations":[]}`.
- Use when: code review or PR preparation. The `review-changes` prompt starts here.
- Limitations: needs git; if git is unavailable or the base cannot be read, the result is empty with a `warnings` entry.

### `bitrix_db_connections`
- Purpose: list Bitrix DB connections parsed from `bitrix/.settings.php` (passwords redacted).
- Parameters: none.
- Example response: `{ "connections": [{ "name": "default", "host": "localhost", "database": "sitemanager", "login": "root", "hasPassword": true }], "source": ".../bitrix/.settings.php" }`.
- Recommended prompt: "Use Bitrix MCP to list the project database connections."
- Use when: before running a DB query, to confirm the target connection.
- Limitations: requires `BITRIX_MCP_DB_ENABLED=1`; never returns passwords.

### `bitrix_db_schema`
- Purpose: introspect tables and columns from `information_schema` for a connection.
- Parameters: `table`, `prefix`, `connection`, `limit`.
- Example response: `{ "database": "sitemanager", "tables": [{ "name": "b_iblock", "columns": [{ "name": "ID", "type": "int" }] }] }`.
- Recommended prompt: "Use Bitrix MCP to show the schema of tables starting with b_iblock."
- Use when: exploring real table structure to write accurate queries.
- Limitations: requires `BITRIX_MCP_DB_ENABLED=1`; filter by `prefix`/`table` to avoid large output.

### `bitrix_db_query`
- Purpose: run a read-only SQL query against the project database.
- Parameters: `sql` (required), `connection`, `limit`.
- Example response: `{ "columns": ["ID", "NAME"], "rows": [{ "ID": 1, "NAME": "Catalog" }], "rowCount": 1, "truncated": false }`; when capped, `truncated: true` with `truncatedReason: "rows"` or `"bytes"`. BIGINT/DECIMAL values are strings, dates are returned as stored, BLOBs as text or `<binary N bytes: …>`, and cells over 4000 characters are truncated.
- Recommended prompt: "Use Bitrix MCP to query the first 5 iblocks."
- Use when: verifying real project data alongside static code search.
- Limitations: requires `BITRIX_MCP_DB_ENABLED=1`; a single `SELECT/SHOW/EXPLAIN/DESCRIBE/WITH` statement without write/lock/file keywords or side-effecting functions (`LOAD_FILE`, `SLEEP`, `BENCHMARK`, …); runs in a read-only transaction with a server-side timeout (15 s); results capped at `limit` rows (default 500) and about 1 MB. MySQL/MariaDB only; PostgreSQL connections return an error.

### `bitrix_db_execute`
- Purpose: run a write SQL statement (INSERT/UPDATE/DELETE) against the project database.
- Parameters: `sql` (required), `connection`.
- Example response: `{ "affectedRows": 1 }`.
- Recommended prompt: "Use Bitrix MCP to update a single test record."
- Use when: intentional data changes on a local dev database.
- Limitations: registered only when `BITRIX_MCP_DB_ALLOW_WRITE=1` (which requires `BITRIX_MCP_DB_ENABLED=1`); annotated `destructiveHint`, and clients with elicitation ask you to approve each call; use with care.

### `bitrix_tinker`
- Purpose: execute arbitrary PHP with the Bitrix kernel bootstrapped (like Laravel Tinker).
- Parameters: `code` (required PHP; use `return <expr>;` to return a value), `timeoutMs`.
- Example response: `{ "ok": true, "returnValue": [{ "ID": 4, "NAME": "Каталог" }], "output": "", "durationMs": 420 }`.
- Recommended prompt: "Use Bitrix MCP tinker to list the first 3 iblocks via IblockTable::getList."
- Use when: verifying real runtime behavior, ORM queries, options, or module APIs.
- Limitations: requires `BITRIX_MCP_TINKER_ENABLED=1`; full code execution and write access — local trusted dev only; annotated `destructiveHint`, and clients with elicitation ask you to approve each call; PHP gets a minimal environment; `output` is truncated at 20k characters, `returnValue` is omitted above 8k characters (use `returnText`), and output over 4 MB kills the process; `exit()`/`die()` returns the output with `exited: true`; a snippet with no explicit `return` reports the PHP `include` value `1`.

## Prompts

The server registers three prompts (`prompts/list`, `prompts/get`). Each returns one user message with a short tool workflow.

| Prompt | Arguments | Workflow |
|---|---|---|
| `review-changes` | `base` (optional git ref, default `HEAD~1`) | `bitrix_detect_changes` → `bitrix_impact_radius` (`includeRisk`) → `bitrix_read_symbol_context`; report what changed, what can break, what to test |
| `explain-api` | `symbol` (e.g. `CIBlockElement::GetList`) | `bitrix_explain_api_usage` → `bitrix_read_symbol_context` / `bitrix_docs_for_symbol`; report signature, example, gotchas, local usages |
| `trace-event` | `module`, `event` (e.g. `main`, `OnBeforeProlog`) | `bitrix_event_search` → `bitrix_graph_neighbors` (`event` node, both directions) → `bitrix_graph_traverse` → `bitrix_read_symbol_context` |

## Completions

Prompt arguments support `completion/complete` from the local index. Lookups are bounded prefix scans (at most 50 values) on a read-only connection and return nothing when no index exists.

- `trace-event.module`: module ids from module includes and event registrations.
- `trace-event.event`: event names, filtered by the `module` argument when it is already set.
- `explain-api.symbol`: symbol and class names (at least two typed characters).
- `review-changes.base`: common refs (`HEAD~1`, `HEAD`, `main`, `master`, `origin/main`, `origin/master`, `develop`).

## Legacy tool names (breaking change)

The release after 0.8.0 replaced sixteen tools with two:

| Removed tool | Replacement |
|---|---|
| `bitrix_agent_search` | `bitrix_entity_search` with `entity: "agent"` |
| `bitrix_mail_event_search` | `entity: "mail_event"` |
| `bitrix_component_search` | `entity: "component"` |
| `bitrix_module_usage_search` | `entity: "module_usage"` |
| `bitrix_iblock_usage_search` | `entity: "iblock_usage"` |
| `bitrix_hlblock_usage_search` | `entity: "hlblock_usage"` |
| `bitrix_option_search` | `entity: "option"` |
| `bitrix_orm_search` | `entity: "orm_entity"` |
| `bitrix_orm_usage_search` | `entity: "orm_usage"` (`entity` filter renamed to `ormEntity`) |
| `bitrix_autoload_search` | `entity: "autoload"` (`type` filter renamed to `autoloadType`) |
| `bitrix_relation_search` | `entity: "relation"` |
| `bitrix_inheritance_search` | `entity: "inheritance"` |
| `bitrix_index_project` | `bitrix_index` with `scope: "project"` |
| `bitrix_index_template` | `scope: "template"` |
| `bitrix_index_all` | `scope: "all"` |
| `bitrix_index_docs` | `scope: "docs"` |

Search results also changed shape: the tools above, `bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_docs_search`, `bitrix_docs_for_symbol`, and `bitrix_orm_entity_map` used to return a bare JSON array (`bitrix_docs_for_symbol`: `{ symbol, results }`; inheritance: `{ query, count, results }`); they now return the [result envelope](#result-envelope-and-pagination). Text output is compact JSON instead of indented JSON.

For one release, set `BITRIX_MCP_LEGACY_TOOLS=1` to register the old names again as thin wrappers: same parameters (plus `cursor`), forwarded to `bitrix_entity_search` / `bitrix_index`, returning the new envelope. The variable and the wrappers will be removed in the next release.
