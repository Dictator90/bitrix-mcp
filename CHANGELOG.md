# Changelog

## 0.4.3

### Fixed

- `init` now shows indexing progress. Its indexing ran through a separate code path that never received a progress reporter, so `bitrix-mcp init` indexed silently. A reporter is now wired into the init flow (progress on stderr, same TTY/CI rules as the `index-*` commands).
- `init` now indexes the Bitrix core through the curated allowlist (modules + admin + tools + js) instead of the old modules-only patterns, matching `index-bitrix` / `index-code`.

## 0.4.2

### Changed

- `index-code` / `index-all` no longer index module `install/` assets by default. Install assets (install components, scripts, etc. — tens of thousands of files on a real project) are now opt-in via `--install` or `--full`, or the dedicated `index-install` command. `--no-bitrix` still skips them too. The MCP `bitrix_index_all` tool follows the same default.

### Fixed

- TTY progress no longer looks "stuck": when a phase finishes it now flushes the final `N/N | 100%` state instead of leaving a stale throttled value (e.g. `1/74 | 1%`) on screen. On fast/incremental scopes the last frame was often never rendered, making it unclear whether indexing had finished.

## 0.4.1

### Fixed

- `lang/` message-file directories are now excluded from **every** index scope by default, not just the Bitrix modules scope. Previously `index-template` / `index-code` / `index-all` still indexed `lang/` under components and templates (e.g. `bitrix/components/**/lang/**`, `local/templates/**/lang/**`). Lang exclusion is now applied globally in file discovery and re-enabled everywhere with `--include-lang` / `--full`.

## 0.4.0

### Changed

- **Bitrix core indexing is now curated and controllable.** The `project` scope no longer crawls `/bitrix/` at all (it previously pulled in `bitrix/wizards`, `bitrix/admin`, `bitrix/js`, … — tens of thousands of core files). The dedicated `bitrix` scope now indexes a curated allowlist — `bitrix/modules` + `bitrix/admin` + `bitrix/tools` + `bitrix/js` (and `local/modules`, `local/js`) — and excludes per-module `lang/` message files by default. Runtime, cache, static assets, wizards and install assets remain excluded. Components/templates stay with the `template` scope. This is a default-behaviour change.

### Added

- `index-bitrix --modules=main,iblock` (and `--modules=all`) to index only selected core modules; unknown modules print a warning and are skipped instead of failing.
- `index-bitrix --full` to index every module plus `lang/` files (alias for `--modules=all --include-lang`, with a slow-run warning), and `--include-lang` to opt lang files back in.
- `index-bitrix --plan` to print the indexing plan (files found / ignored / queued, top modules) without indexing.
- `index-code` / `index-all` accept `--no-bitrix` (skip the Bitrix core and install scopes) and `--bitrix-modules=…` / `--full` / `--include-lang`.
- New `resolveBitrixIndex` / `validateBitrixModules` policy resolver and a shared `discoverFiles` helper.

## 0.3.3

### Changed

- `buildIndex` now returns the manifest it built in memory instead of re-reading the whole index back from SQLite. The readback issued a per-file query fan-out across every child table purely to hand callers a value they only use for `manifest.files.length`, adding seconds per scope on large projects (and minutes before the `file_id` indexes). Unchanged files remain fully indexed in SQLite; only the returned manifest skips rehydrating them.

## 0.3.2

### Fixed

- Fixed `index-all` / `index-code` appearing to hang for many minutes after a scope finished. `readIndexFromSqlite` runs a `WHERE file_id = ?` query per file against each child table, but those tables had no index on `file_id`, so the post-index readback of a large project (12k+ files / 130k+ symbols) ran as full table scans and took ~9 minutes. Added `file_id` indexes on `symbols`, `module_usages`, `orm_entities`, `orm_usages`, `iblock_usages`, `hlblock_usages`, and `option_usages`, cutting that readback to a few seconds (~190× faster). The indexes are created on store open, so existing databases are upgraded automatically on the next run — no reindex required.

## 0.3.1

### Added

- `--version` / `-v` flag that prints the installed bitrix-mcp version and exits. The version is read from `package.json` so it works from both the source (`tsx`) and the built `dist/cli.js`.

## 0.3.0

### Added

- Visual indexing progress for all `index-*` commands (`index-project`, `index-template`, `index-bitrix`, `index-install`, `index-docs`, `index-code`, `index-all`). Progress is on by default in an interactive terminal, always written to `stderr` (never `stdout`), and shows the current phase, scope, processed/total files, current file, elapsed time, and a final summary.
- `--compact` progress mode using dots for ongoing work and checkmarks for completed phases/scopes, with a one-line summary per scope.
- `--no-progress` to disable progress, `--progress` to force it on a non-interactive shell, and `--json-progress` to emit JSON Lines progress events to `stderr`.
- New `src/progress/` reporting layer (`ProgressReporter` interface with Noop/Tty/Compact/Json implementations and a `createProgressReporter` factory) so indexers stay free of ad-hoc logging and `serve` (MCP stdio) stays unaffected.

### Fixed

- Restored `tests/fixtures/project/index.php` class declaration to valid `DemoComponent`, preventing PHP AST fallback and recovering symbol/index/context test coverage.
- Hardened symbol-context and detect-changes indexed record lookups to normalize `./`, Windows-backslash, relative, and absolute file filters consistently.
- Added regression coverage for fixture PHP class/method AST line bounds, SQLite class search, method context lookup, and indexed-record path matching.
- Stabilized Windows test runs by using slash-normalized relative path expectations and file URL `--import` loader paths for CLI test launches.
- Stored generated Bitrix relation file paths as slash-normalized workspace-relative paths so detect-changes and graph lookups can match indexed records consistently across platforms.
- Skipped the Unix-shell-dependent `autrobin/bitrix.core` updater integration test on Windows instead of requiring Git Bash.

## 0.2.0

Initial public npm release under `@mb4it/bitrix-mcp`.

### Added

- Local MCP server for Bitrix Framework / 1C-Bitrix projects.
- Project, template, Bitrix module, install asset, and documentation indexing.
- LiveAPI search for PHP symbols and Bitrix APIs.
- Bitrix event handler search.
- Module usage search for `Loader::includeModule`, `CModule::IncludeModule`, `IsModuleInstalled`, and `ModuleManager::isModuleInstalled`.
- Agent, mail event, component, ORM, IBlock, Highloadblock, and option indexing/search.
- `bitrix_relations` storage and Bitrix-aware dependency graph.
- Graph neighbors, graph traversal, impact radius, and detect-changes workflows.
- Source context tools: `bitrix_read_file_context` and `bitrix_read_symbol_context`.
- Documentation search, docs-for-symbol, and API usage explanation.
- Optional semantic documentation search via Python embeddings service.
- Benchmark reporting.
- Release documentation and npm publication safety metadata for the scoped public package.
- Build output layout for the published package now emits `dist/cli.js` and runtime files without compiled tests.

### Notes

- Package name is `@mb4it/bitrix-mcp`.
- Requires Node.js 22.12+ because the package uses `node:sqlite`.
- CLI command remains `bitrix-mcp`.

- Corrected the Node.js runtime requirement to Node.js 22.12+ for `node:sqlite` compatibility across package metadata and docs.
- Hardened `bitrix_detect_changes` to reuse graph impact radius, include components, ORM entities/usages, IBlock usages, Highloadblock usages, and options, merge graph risk reasons deterministically, and emit impact-aware CLI/MCP output.
- Updated README/tool documentation, AGENTS.md guidance, and tests for the expanded detect-changes output, CLI impact summary, and runtime compatibility.

- Hardened Phase 18 consistency: compact LiveAPI/event search now prefers workspace-relative file paths, MCP schemas have tighter kind/relation/file limits, `detect-changes` returns deterministic warnings when Git is unavailable, graph impact input files are capped, and generated directories are skipped by default.
- Added tests for Git-unavailable change detection and built-in generated/cache/upload/vendor/node_modules index ignores.

- Added benchmark reporting via `npm run benchmark` and `bitrix-mcp benchmark`, writing `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md` with graceful skips for missing Bitrix roots, docs, and optional indexes.
- Added Phase 17 documentation for implemented MCP tools, indexing, events, ORM, components, graph traversal, change detection, security, and example prompts.

- Added documentation-to-symbol indexing with `doc_symbol_refs`, regex extraction for common Bitrix API references, and SQLite lookup by symbol.
- Added `bitrix_docs_for_symbol` and `bitrix_explain_api_usage` MCP tools to combine documentation, local usages, core definitions, relations, and deterministic API recommendations.
- Added tests for symbol extraction, doc-symbol storage/search, compact MCP outputs, missing-doc behavior, and combined API usage explanations.

- Added Composer/autoload indexing for `composer.json` PSR-4 mappings, autoload files, classmaps, dependencies, dev dependencies, and common Bitrix bootstrap/config files.
- Added `bitrix_autoload_search` and `bitrix_project_overview` MCP tools with compact JSON output, autoload/dependency relations, project summary counters, entity lists, and warnings.
- Updated generated Bitrix MCP agent guidance and repository `AGENTS.md` to call `bitrix_index_status`, `bitrix_project_overview`, `bitrix_detect_changes`, and graph tools at the right stages.
- Added tests for Composer autoload indexing, bootstrap detection, autoload relations, project overview warnings, and compact MCP output.

- Added a Bitrix-aware dependency graph over `bitrix_relations` with bounded neighbor lookup, BFS traversal, impact-radius analysis, relation weighting, MCP tools, optional CLI commands, docs, and tests.

- Added PHP AST enrichment for namespaces, imports, fully qualified names, inheritance, trait usage, modifiers, return types, parameters, defaults, and declaration end lines.
- Added inheritance relation writes for class `extends`, `implements`, and trait-use metadata plus `bitrix_inheritance_search` for querying those relationships.
- Extended symbol SQLite persistence with optional enriched PHP metadata while preserving backward-compatible symbol fields.
- Added parser, relation, and MCP coverage for enriched PHP symbols and inheritance searches.

- Added `bitrix_read_symbol_context` MCP tool for reading source excerpts by indexed symbol name with ambiguity reporting, body expansion via `lineEnd`, path allowlist checks, and truncation controls.
- Added `lineEnd` metadata for AST-indexed PHP class, interface, trait, function, and method symbols while keeping existing symbol records compatible.
- Added tests for symbol context reads, ambiguity handling, body inclusion, path safety, and truncation.
- Added Bitrix module option usage indexing for `Option::get/set`, fully qualified `Bitrix\Main\Config\Option::get/set`, and legacy `COption` option APIs.
- Added SQLite storage, relation writes, search formatting, and the `bitrix_option_search` MCP tool for option reads/writes.
- Added coverage for option parsing, dynamic option-name safety, relation creation, and MCP tool search behavior.
