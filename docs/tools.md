# MCP tools

This page documents the MCP tools implemented in `src/mcp/server.ts`. Tools return JSON text; examples below are compact and illustrative.

Recommended AI workflow:

- General project work: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_docs_search` as needed → `bitrix_read_file_context` or `bitrix_read_symbol_context`.
- Review work: `bitrix_detect_changes` → `bitrix_impact_radius` → `bitrix_graph_neighbors` or `bitrix_graph_traverse` → `bitrix_relation_search` → source context tools.
- Bitrix events: `bitrix_event_search` → `bitrix_relation_search` → `bitrix_graph_neighbors` → `bitrix_read_file_context`.
- ORM: `bitrix_orm_search` → `bitrix_orm_entity_map` → `bitrix_orm_usage_search` → `bitrix_graph_neighbors`.
- Components: `bitrix_component_search` → `bitrix_component_context` → `bitrix_impact_radius` when changing component files.

## Tool reference

### `bitrix_index_status`
- Purpose: show SQLite path and index counters.
- Parameters: none.
- Example response: `{ "files": 1200, "symbols": 9000, "events": 45, "relations": 3000 }`.
- Recommended prompt: "Use Bitrix MCP to check whether indexes are fresh before answering."
- Use when: starting any task or checking benchmark/index health.
- Limitations: counters are only as current as the last index run.

### `bitrix_project_overview`
- Purpose: summarize indexed project structure, top entities, autoload coverage, and warnings.
- Parameters: `includeTopFiles`, `includeModules`, `includeComponents`, `includeEvents`, `includeOrm`, `includeAgents`, `includeMailEvents`, `includeWarnings`, `format`.
- Example response: `{ "summary": { "files": 1200, "components": 34 }, "warnings": ["no events found"] }`.
- Recommended prompt: "Use Bitrix MCP to summarize the project before making changes."
- Use when: planning larger work.
- Limitations: overview is derived from SQLite indexes and may omit unindexed/generated code.

### `bitrix_index_project`
- Purpose: index project files excluding Bitrix core/template scopes.
- Parameters: `root` optional path inside workspace by default.
- Example response: `{ "projectFiles": 180, "dbFile": ".bitrix-mcp/bitrix-mcp.sqlite" }`.
- Recommended prompt: "Use Bitrix MCP to index the project before searching local symbols."
- Use when: local code changed.
- Limitations: MCP path restrictions keep indexing inside workspace unless explicitly configured.

### `bitrix_index_template`
- Purpose: index templates, components, scripts, styles, and layout assets.
- Parameters: `templatePath`, deprecated alias `root`.
- Example response: `{ "templateFiles": 75, "dbFile": ".bitrix-mcp/bitrix-mcp.sqlite" }`.
- Recommended prompt: "Use Bitrix MCP to refresh template indexes for local/templates/site."
- Use when: changing templates/components/assets.
- Limitations: `templatePath` is relative to workspace by default.

### `bitrix_index_all`
- Purpose: index project, templates, Bitrix modules, install assets, and docs.
- Parameters: none.
- Example response: `{ "projectFiles": 180, "templateFiles": 75, "bitrixFiles": 0, "docChunks": 420 }`.
- Recommended prompt: "Use Bitrix MCP to rebuild all indexes, then answer using indexed context."
- Use when: initial setup or broad refresh.
- Limitations: official docs may require network when enabled; Bitrix root is skipped if absent.

### `bitrix_index_docs`
- Purpose: clone/pull configured docs and index documentation chunks into SQLite.
- Parameters: none.
- Example response: `{ "docChunks": 420, "dbFile": ".bitrix-mcp/bitrix-mcp.sqlite" }`.
- Recommended prompt: "Use Bitrix MCP to index docs before explaining Bitrix API usage."
- Use when: docs search has no results or docs changed.
- Limitations: Git sources require network; semantic indexing is separate.

### `bitrix_liveapi_search`
- Purpose: search indexed symbols: classes, methods, functions, events, components, constants, mail events, and frontend exports.
- Parameters: `query` required; `type`, `module`, `kind`, `preferLocal`, `limit`, `includeSignature`, `maxSignatureChars`, `maxTextChars`, `format`.
- Example response: `{ "count": 1, "results": [{ "type": "method", "name": "CIBlockElement::GetList", "file": "bitrix/...", "line": 10 }] }`.
- Recommended prompt: "Use Bitrix MCP to find Loader::includeModule('iblock') usages."
- Use when: looking for APIs or local symbols.
- Limitations: depends on indexed files and parser coverage.

### `bitrix_docs_search`
- Purpose: SQLite FTS search across indexed documentation chunks.
- Parameters: `query` required; `limit`, `includeSignature`, `maxSignatureChars`, `maxTextChars`, `format`.
- Example response: `{ "count": 2, "results": [{ "title": "Managed cache", "uri": "bitrix-docs://..." }] }`.
- Recommended prompt: "Use Bitrix MCP docs search to verify the API behavior before coding."
- Use when: needing local Bitrix docs without embeddings.
- Limitations: requires `bitrix_index_docs` or `index-all`; ranking is lexical.

### `bitrix_semantic_docs_search` *(optional)*
- Purpose: semantic documentation search through an embeddings service.
- Parameters: `query`, `limit`, `includeSignature`, `maxSignatureChars`, `maxTextChars`, `format`.
- Example response: `{ "query": "managed cache invalidation", "results": [{ "score": 0.82, "title": "Cache" }] }`.
- Recommended prompt: "Use semantic docs search if FTS misses conceptual documentation."
- Use when: `BITRIX_MCP_SEMANTIC_ENABLED=1` and embeddings service is running.
- Limitations: tool is not registered unless semantic mode is enabled.

### `bitrix_docs_for_symbol`
- Purpose: find doc chunks mentioning a specific API symbol.
- Parameters: `symbol` required; `limit`, `format`.
- Example response: `{ "symbol": "CIBlockElement::GetList", "results": [{ "uri": "bitrix-docs://..." }] }`.
- Recommended prompt: "Use Bitrix MCP to find docs for CIBlockElement::GetList."
- Use when: moving from code symbol to documentation.
- Limitations: depends on doc symbol extraction during docs indexing.

### `bitrix_explain_api_usage`
- Purpose: combine docs, local usages, core definitions, relations, and deterministic recommendations for an API.
- Parameters: `query` required; `kind`, `includeDocs`, `includeLocalUsages`, `includeCoreDefinition`, `limit`, `format`.
- Example response: `{ "query": "Loader::includeModule", "docs": [], "localUsages": [], "recommendations": [] }`.
- Recommended prompt: "Use Bitrix MCP to explain correct Loader::includeModule usage."
- Use when: validating API usage before edits.
- Limitations: recommendations are deterministic summaries, not a replacement for official docs review.

### `bitrix_read_file_context`
- Purpose: read bounded numbered source lines from an allowed file.
- Parameters: `file`, `line`, `before`, `after`, `maxChars`.
- Example response: `{ "metadata": { "relativePath": "local/php_interface/init.php", "startLine": 1 }, "numberedLines": "1: <?php" }`.
- Recommended prompt: "Use Bitrix MCP to read context around line 42 of local/php_interface/init.php."
- Use when: a search result points to a file/line.
- Limitations: reads only inside workspace or data directory allowlist.

### `bitrix_read_symbol_context`
- Purpose: resolve an indexed symbol and read source around its definition/usage.
- Parameters: `name`, `type`, `kind`, `file`, `before`, `after`, `includeBody`, `maxChars`, `format`.
- Example response: `{ "ambiguous": false, "symbol": { "name": "SaleHandler", "line": 12 }, "context": { "numberedLines": "..." } }`.
- Recommended prompt: "Use Bitrix MCP to read the handler class body for OnSaleOrderSaved."
- Use when: you know a symbol name but not exact file/line.
- Limitations: ambiguous names require narrowing by type, kind, or file.

### `bitrix_event_search`
- Purpose: search indexed Bitrix event handlers by event module/name or handler.
- Parameters: `query`, `module`, `kind`, `preferLocal`, `limit`, response formatting options.
- Example response: `{ "count": 1, "results": [{ "module": "sale", "name": "OnSaleOrderSaved", "handlerMethod": "onSave" }] }`.
- Recommended prompt: "Use Bitrix MCP to find all handlers for sale module events."
- Use when: auditing event registrations.
- Limitations: only registrations detectable from indexed code are returned.

### `bitrix_relation_search`
- Purpose: search canonical `bitrix_relations` graph edges.
- Parameters: `sourceType`, `sourceName`, `targetType`, `targetName`, `relationType`, `module`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "source": "event:main:OnBeforeProlog", "target": "handler:App\\Handler::run" }] }`.
- Recommended prompt: "Use Bitrix MCP to find relations for this event or component."
- Use when: connecting indexed entities.
- Limitations: graph quality depends on relation extraction; traversals are bounded.

### `bitrix_graph_neighbors`
- Purpose: return immediate or bounded-depth graph neighbors from `bitrix_relations`.
- Parameters: `nodeType`, `nodeName`, `direction`, `relationType`, `depth`, `limit`, `format`.
- Example response: `{ "node": { "type": "component", "name": "bitrix:catalog.section" }, "neighbors": [] }`.
- Recommended prompt: "Use Bitrix MCP to show neighbors for bitrix:catalog.section."
- Use when: checking direct dependencies.
- Limitations: depth maximum is 5.

### `bitrix_graph_traverse`
- Purpose: cycle-safe BFS traversal of the Bitrix dependency graph.
- Parameters: `startType`, `startName`, `direction`, `maxDepth`, `relationTypes`, `limit`, `format`.
- Example response: `{ "nodes": [{ "type": "component", "name": "bitrix:catalog.section", "depth": 0 }], "edges": [] }`.
- Recommended prompt: "Use Bitrix MCP to traverse graph dependencies for bitrix:catalog.section."
- Use when: exploring transitive dependencies.
- Limitations: bounded by depth and limit to avoid runaway traversals.

### `bitrix_impact_radius`
- Purpose: find likely impacted entities for changed files or Git diff.
- Parameters: `files`, `base`, `maxDepth`, `relationTypes`, `includeChangedSymbols`, `includeRisk`, `limit`, `format`.
- Example response: `{ "changedFiles": ["local/php_interface/init.php"], "impacted": { "events": [] }, "risk": { "level": "low" } }`.
- Recommended prompt: "Use Bitrix MCP to show the impact radius for local/php_interface/init.php."
- Use when: reviewing changes before tests/deploy.
- Limitations: impact is graph-derived and should be validated with tests.

### `bitrix_detect_changes`
- Purpose: analyze Git-changed Bitrix files against indexed symbols and relations.
- Parameters: `base`, `kind`, `includeSource`, `includeRelations`, `maxFiles`, `maxItems`, `format`.
- Example response: `{ "summary": { "files": 2, "symbols": 5, "relations": 3 }, "recommendations": [] }`.
- Recommended prompt: "Use Bitrix MCP to analyze changes since origin/main."
- Use when: code review or PR preparation.
- Limitations: requires Git to calculate changed files; if Git is unavailable or the base cannot be read, the tool returns an empty result with a `warnings` entry instead of crashing.

### `bitrix_inheritance_search`
- Purpose: find classes extending/implementing/using a target class/interface/trait.
- Parameters: `target`, `relation`, `kind`, `module`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "className": "App\\Child", "relation": "extends", "targetName": "Base" }] }`.
- Recommended prompt: "Use Bitrix MCP to find implementations of this interface."
- Use when: refactoring class hierarchies.
- Limitations: PHP parser fallback may miss complex dynamic inheritance.

### `bitrix_agent_search`
- Purpose: search indexed `CAgent` registrations.
- Parameters: `query`, `module`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "name": "App\\Agent::run();", "module": "main" }] }`.
- Recommended prompt: "Use Bitrix MCP to find scheduled agents for this module."
- Use when: auditing background tasks.
- Limitations: dynamic agent strings may be reported with limited context.

### `bitrix_mail_event_search`
- Purpose: search `CEvent::Send`, `Event::send`, and related mail-event handlers.
- Parameters: `query`, `eventName`, `api`, `kind`, `file`, `includeHandlers`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "eventName": "SALE_NEW_ORDER", "api": "CEvent::Send" }] }`.
- Recommended prompt: "Use Bitrix MCP to find all CEvent::Send calls for SALE_NEW_ORDER."
- Use when: tracing email notifications.
- Limitations: event names built dynamically may not be exact.

### `bitrix_component_search`
- Purpose: search `IncludeComponent` usages.
- Parameters: `query`, `component`, `template`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "component": "bitrix:catalog.section", "template": ".default" }] }`.
- Recommended prompt: "Use Bitrix MCP to explain where this component template is used."
- Use when: changing component calls or templates.
- Limitations: parameters are best-effort extracted from static calls.

### `bitrix_component_context`
- Purpose: return component calls, resolved template files/assets, params, and relations.
- Parameters: `component`, `template`, `callFile`, `includeFiles`, `includeAssets`, `includeParams`, `format`.
- Example response: `{ "component": "bitrix:catalog.section", "calls": [], "templateFiles": [] }`.
- Recommended prompt: "Use Bitrix MCP to inspect context for bitrix:catalog.section template .default."
- Use when: assessing template impact.
- Limitations: resolution follows indexed template conventions and may not execute Bitrix runtime logic.

### `bitrix_module_usage_search`
- Purpose: search `Loader::includeModule`, `CModule::IncludeModule`, and module checks.
- Parameters: `module`, `call`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "module": "iblock", "call": "Loader::includeModule" }] }`.
- Recommended prompt: "Use Bitrix MCP to find all Loader::includeModule('iblock') usages."
- Use when: auditing module dependencies.
- Limitations: dynamic module names may not be resolved.

### `bitrix_iblock_usage_search`
- Purpose: search IBlock API usages and `IBLOCK_ID` references.
- Parameters: `query`, `iblockId`, `api`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "iblockId": "7", "api": "CIBlockElement::GetList" }] }`.
- Recommended prompt: "Use Bitrix MCP to find iblock 7 usages."
- Use when: migrating or changing IBlock code.
- Limitations: symbolic/dynamic IDs may appear as context rather than exact IDs.

### `bitrix_hlblock_usage_search`
- Purpose: search Highloadblock API usage by ID/code/API.
- Parameters: `query`, `hlblockId`, `api`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "hlblockId": "CatalogColors", "api": "HighloadBlockTable::getList" }] }`.
- Recommended prompt: "Use Bitrix MCP to find Highloadblock usages for CatalogColors."
- Use when: refactoring HL-block entities.
- Limitations: dynamic codes/IDs are best-effort.

### `bitrix_option_search`
- Purpose: search module option reads/writes via `Option`/`COption` APIs.
- Parameters: `query`, `module`, `name`, `operation`, `api`, `kind`, `file`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "module": "sale", "name": "allow_deduction", "operation": "get" }] }`.
- Recommended prompt: "Use Bitrix MCP to find writes to this module option."
- Use when: auditing configuration changes.
- Limitations: dynamic option names may be partial.

### `bitrix_orm_search`
- Purpose: search D7 ORM DataManager entities.
- Parameters: `query`, `tableName`, `className`, `module`, `kind`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "className": "ProductTable", "tableName": "b_catalog_product" }] }`.
- Recommended prompt: "Use Bitrix MCP to find all ORM entities and their table names."
- Use when: mapping database entities.
- Limitations: requires statically detectable DataManager classes.

### `bitrix_orm_entity_map`
- Purpose: return `getMap()` fields and references for an entity.
- Parameters: `className`, `tableName`, `file`, `format`.
- Example response: `{ "entity": { "className": "ProductTable", "tableName": "b_catalog_product" }, "fields": [] }`.
- Recommended prompt: "Use Bitrix MCP to show the ORM field map for ProductTable."
- Use when: changing ORM queries or schema-dependent code.
- Limitations: complex computed maps may be incomplete.

### `bitrix_orm_usage_search`
- Purpose: search ORM calls such as `getList`, `query`, `add`, `update`, `delete`, and `compileEntity`.
- Parameters: `query`, `entity`, `method`, `file`, `kind`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "entity": "ProductTable", "method": "getList" }] }`.
- Recommended prompt: "Use Bitrix MCP to find ProductTable::getList usages."
- Use when: assessing ORM change impact.
- Limitations: dynamic class names may not map to entities.

### `bitrix_autoload_search`
- Purpose: search Composer autoload mappings, dependencies, classmaps, autoload files, and bootstrap/config files.
- Parameters: `query`, `namespace`, `package`, `type`, `limit`, `format`.
- Example response: `{ "count": 1, "results": [{ "type": "psr-4", "namespace": "App\\", "path": "src/" }] }`.
- Recommended prompt: "Use Bitrix MCP to find autoload mapping for App\\."
- Use when: debugging class loading or package dependencies.
- Limitations: reflects Composer/bootstrap files present during indexing.
