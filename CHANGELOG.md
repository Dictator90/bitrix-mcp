# Changelog

## 0.9.0

Search quality, parser coverage, Bitrix framework features, and a smaller, typed MCP tool surface. The index is migrated automatically (schema v5, parser version 3): full-text indexes are rebuilt and every file is re-parsed once.

### Breaking changes

- **Consolidated MCP tools (31 → 17 by default).**
  - Twelve `*_search` tools are replaced by `bitrix_entity_search({ entity, … })`. The entities are `agent`, `mail_event`, `component`, `module_usage`, `iblock_usage`, `hlblock_usage`, `option`, `orm_entity`, `orm_usage`, `autoload`, `relation`, `inheritance`, plus the new `feature`. Two filters were renamed: `orm_usage` `entity` → `ormEntity`, and `autoload` `type` → `autoloadType`.
  - `bitrix_index_project`, `_template`, `_all` and `_docs` are replaced by `bitrix_index({ scope })`, with scope `project`, `template`, `bitrix`, `install`, `docs` or `all`. The `bitrix` scope (with an optional `modules` list) and the `install` scope are new over MCP.
  - `BITRIX_MCP_LEGACY_TOOLS=1` brings the old names back for this release; they forward to the new tools.
  - `docs/tools.md` has a migration table. `init`/`configure` write guidance and hooks that name the new tools.
- **Search and list tools return a result envelope** `{ count, total?, truncated, nextCursor?, results }` instead of bare arrays, and all text output is compact JSON.
- **`bitrix_inheritance_search` / `entity: "inheritance"` matches strictly.** A name containing a backslash matches that FQN exactly. A short name matches only the last namespace segment.
- **Graph node types changed.** Inheritance edges now point at `class:<FQN>` nodes for parent classes, interfaces and traits alike. The `relation_type` (`extends`, `implements`, `uses_trait`) and `metadata.targetKind` still carry the difference.
- **`lang/` is indexed in the project and template scopes**, so `$MESS` phrases are searchable. The Bitrix core and install scopes still skip `lang/` by default.

### Added

- **Bitrix framework features**, via `bitrix_entity_search({ entity: "feature", featureType })`, with graph edges:
  - controllers and routing: D7 controller actions, `routes/*.php` routes, `urlrewrite.php` rules;
  - REST methods from `OnRestServiceBuildDescription` handlers;
  - language phrases (`$MESS`) and their `Loc::getMessage` / `GetMessage` usages;
  - JS extensions (with their dependencies) and where they are loaded;
  - `Loader` autoload registrations;
  - UF fields and iblock properties;
  - component parameters and descriptions;
  - JS side: `BX.ajax.runAction` / `runComponentAction` calls and JS custom events.

  See `docs/indexing.md`.
- **Fired events.**
  - `new \Bitrix\Main\Event(...)`, `GetModuleEvents` and `EventManager::findEventHandlers` are indexed as `event_emit` symbols, with `emits_event` edges.
  - Unregistering a handler is indexed as `event_unregister`.
- **More PHP constructs are indexed:**
  - enums and their cases, and every parent of an interface;
  - PHPDoc summaries, stored as symbol descriptions;
  - calls nested inside arrays and `new` arguments.
- **MCP protocol features:**
  - every tool is registered with a title, a description for every parameter, and annotations;
  - search tools declare an `outputSchema` and return `structuredContent`;
  - cursor pagination (`cursor` / `nextCursor`);
  - the server sends `instructions` describing the recommended workflow;
  - prompts `review-changes`, `explain-api` and `trace-event`;
  - completions from the index for modules, events, symbols and git refs.
- **Real diffs in `bitrix_detect_changes`.**
  - `symbolDiff` reports added, removed and changed symbols per file.
  - Deleted files are listed with the symbols they had; untracked files are included.
  - `install/` paths are classified correctly, and git errors come back as warnings.
- **Graph:**
  - `bitrix_inheritance_search` has a `transitive` mode, bounded and cycle-safe.
  - Graph tools accept `maxEdgesPerNode` to cap hub nodes; capped nodes are listed in `truncatedNodes`.
- **New CLI commands:**
  - `bitrix-mcp watch` re-indexes only what changed while you edit.
  - `bitrix-mcp clean` removes index data, with `--dry-run`, `--yes` and `--all`.
  - `init --dry-run` / `configure --dry-run` show per-file diffs without writing anything.
- **New docs:** `ARCHITECTURE.md` and `CONTRIBUTING.md`.

### Changed

- **Search understands identifiers and Russian.**
  - Names are split into camelCase, namespace and snake_case parts, and the legacy `C` prefix is recognised: `iblock` finds `CIBlockElement`, and `ElementAdd` finds `OnBeforeIBlockElementAdd`.
  - Docs search uses Porter stemming for English and a Snowball stemmer for Russian: «обработчик события» finds «Обработчики событий».
  - Ranking goes exact match → prefix → column-weighted bm25, with local code boosted inside relevance instead of as a hard tier.
  - The `LIKE '%…%'` full-table scans are gone. On a 3000-file project, `iblock` takes 1.3 ms instead of 60 ms.
- **PHP parsing:**
  - A file with a syntax error keeps a partially recovered syntax tree instead of falling back to the regex parser.
  - Uses php-parser 3.7 with PHP 8.4 syntax (property hooks).
  - Two php-parser infinite loops on truncated input are guarded.
- **ORM:**
  - entity and field detection covers fluent fields, `Reference`/`OneToMany`/`ManyToMany`, legacy array maps, `$map` variables and `*Table` subclasses;
  - ORM usages are limited to `*Table` classes and skip `self`/`static`/`parent`, `CUser` and variable targets.
- **Event handlers** written as `[self::class, 'm']`, `[static::class, 'm']`, `__CLASS__` or `$this` resolve to the real class. `registerEventHandlerCompatible` is supported.
- **Legacy cp1251 source files** are decoded correctly.
- **JS:**
  - `bitrix/js/<module>` files get their module;
  - class `extends` is recorded;
  - `BX.Foo = function`, `prototype` and `BX.namespace` declarations are indexed.
- **Graph performance:**
  - traversal uses one database connection and a batched query per BFS level;
  - `bitrix_impact_radius` runs one combined traversal instead of up to 1000;
  - method start nodes are fully qualified;
  - PHP class and method names match case-insensitively.
- **Startup:** `--version` and `--help` take about 70 ms (was about 700 ms), and `status` about 120 ms. Parsers, the MCP SDK and the MySQL/tinker modules load on first use.
- **Embeddings service:**
  - the default model is now `intfloat/multilingual-e5-small`, which reads 512 tokens (the old default truncated chunks at 128);
  - encoding is batched and the index is written atomically;
  - an optional `BITRIX_MCP_EMBEDDINGS_TOKEN` enables token auth;
  - it binds to loopback by default;
  - the client has timeouts.

  Re-run `bitrix-mcp index-embeddings` after upgrading.

### Fixed

- Re-indexing a single directory (`index-template <path>` or `watch`) no longer drops the parse warnings and file count of the rest of the scope.
- Duplicate ORM `extends` edges are no longer written.

## 0.8.0

Storage and runtime release: no more "database is locked", faster indexing and searches, and partial re-indexing that no longer loses data. The index database is migrated automatically on first use, and every file is re-parsed once by the new parser version.

### Fixed

- **Searches no longer fail with "database is locked" during indexing.** Every search, and every node of a graph traversal, used to re-run the whole schema DDL plus a full FTS resync. That took a write lock and cost about 0.5 s per call on large indexes. Migrations now run once per database, tracked with `PRAGMA user_version`. Every connection waits up to 5 s for a concurrent writer (`busy_timeout`), and indexing writes in transactions of 250 files instead of one run-long transaction.
- **Re-indexing part of a scope no longer deletes the rest.** Before, `bitrix_index_template({ templatePath: "local/templates/main" })` removed every other template from the index, and the same happened with a custom `bitrix_index_project` root. Pruning is now limited to the scanned directory. Paths stay workspace-relative, so component names still resolve.
- **Upgrades re-parse stale files automatically.** Each file records the parser version that indexed it. Unchanged files from an older parser are re-parsed on the next run, instead of keeping stale symbols until `--force`.
- **One bad file no longer aborts a run.** A file that disappears between discovery and parsing, or fails to parse, is reported as a `file_error` warning in `status`.
- **Parallel index calls queue instead of colliding.** MCP index tools run one at a time; a waiting call can be cancelled.
- **A crashed or exited worker fails the tool call immediately.** Before, it hung until the 10-minute timeout; this includes an OOM `SIGKILL` and a worker exiting with code 0.
- `bitrix-mcp benchmark` re-indexes the Bitrix scope with the same module selection as `index-bitrix`, so it no longer prunes `bitrix/admin`, `tools` and `js` from your index.

### Changed

- **Method call sites are no longer symbols.**
  - `Class::method()` and `$obj->method()` calls were stored as `static_call`/`method_call` symbols, each with the full source text of the call as its signature. That flooded `bitrix_liveapi_search` results and bloated the database.
  - They now live in a lean `call_sites` table, with signatures capped at 160 characters. `bitrix_explain_api_usage` reads them for "local usages".
  - `bitrix_liveapi_search` no longer returns `static_call`/`method_call` results.
- **Faster indexing.**
  - Runs with 200+ changed files parse in worker threads (`BITRIX_MCP_INDEX_WORKERS`, default CPUs − 1, at most 4), pipelined with the SQLite writes.
  - On a synthetic 3000-file project, a full index went from 20.2 s to 11.9 s and the database from 283 MB to 217 MB.
- **Faster searches.** MCP read/search tools run on a pool of long-lived worker threads (`BITRIX_MCP_WORKERS`, default 2). Before, every call started a new worker and reloaded every module (about 0.5–1 s); searches after the first now take a few milliseconds.
- **Separate timeouts.** Read/search tools time out after 30 s (`BITRIX_MCP_TOOL_TIMEOUT_MS`). Index tools, `bitrix_tinker` and `bitrix_db_execute` keep 10 minutes (`BITRIX_MCP_HEAVY_TOOL_TIMEOUT_MS`).
- The SQLite store implementation is split from the 3300-line `sqliteStore.ts` into `src/indexer/store/` modules; the public API is unchanged.

### Added

- **MCP cancellation is honoured.** A cancelled index or search stops its worker, and a queued index call is dropped.
- **Index tools send `notifications/progress`** when the client passes a `progressToken`.
- **`bitrix-mcp serve` shuts down cleanly.** It exits when stdin closes and stops running workers.
- **The stdio protocol is protected.** Output a task prints to stdout is redirected to stderr, so it cannot corrupt the protocol stream.

## 0.7.0

Security and robustness release. Some changes are **breaking** for scripts: see "CLI" below.

### Security

- **`bitrix_db_query` read-only mode is now enforced, not just keyword-checked.** The old first-keyword check let through `WITH … DELETE` (MySQL 8), `SELECT … INTO OUTFILE` (writing files, e.g. a web shell into `upload/`), `SELECT LOAD_FILE(…)` (reading files outside the workspace), `FOR UPDATE`, executable comments, and `SLEEP`/`BENCHMARK` (tying up the DB). Now:
  - a string- and comment-aware SQL lexer rejects write, lock and file keywords anywhere in the statement, executable comments (`/*! … */`), and side-effecting functions (`LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `NEXTVAL`, …); `SHOW CREATE TABLE`, `REPLACE()`/`INSERT()` string functions and keywords inside strings or backticks still work;
  - the statement runs inside `START TRANSACTION READ ONLY … ROLLBACK`;
  - a server-side statement timeout is set (`max_statement_time` on MariaDB, `MAX_EXECUTION_TIME` on MySQL), and on timeout the query is killed on the server with `KILL QUERY` instead of running on after the client gives up.
- **New `BITRIX_MCP_DB_READONLY_USER` / `BITRIX_MCP_DB_READONLY_PASSWORD`.** When set, `bitrix_db_query` and `bitrix_db_schema` connect with this (ideally `SELECT`-only) account instead of the `.settings.php` one.
- **Credential and dump files are no longer returned or indexed.** `bitrix_read_file_context` and `bitrix_read_symbol_context` refuse `.settings.php`, `.settings_extra.php`, `php_interface/dbconn.php`, `bitrix/license_key.php`, `.env*`, VCS and `.ssh` directories, `.htpasswd`, `.npmrc`, `auth.json`, keys and certificates, SQL dumps, SQLite files and `bitrix/backup/`, and indexing skips them. Previously `bitrix_read_file_context({ file: "bitrix/.settings.php" })` returned the DB password in plain text. Override with `BITRIX_MCP_ALLOW_SECRET_FILES=1`. Context reads also refuse binary files and files over 10 MB instead of loading them whole.
- **`bitrix_tinker` no longer passes the MCP client's environment to PHP.** PHP gets only PATH, HOME, locale, temp, PHP ini and Windows system variables, so API tokens and cloud credentials are not readable from snippets. Add variables with `BITRIX_MCP_TINKER_ENV_PASSTHROUGH=VAR1,VAR2`.
- **Tool annotations and confirmation.** Every tool now carries MCP annotations (`readOnlyHint` for searches and reads, non-destructive writes for index tools, `destructiveHint` for `bitrix_db_execute` and `bitrix_tinker`). With clients that support MCP elicitation, those two tools ask you to approve each call, showing the SQL or PHP; `BITRIX_MCP_CONFIRM_DANGEROUS=0` disables the prompt.

### Added

- **`bitrix-mcp uninstall [--agent <id>] [--all-agents] [--dry-run]`** removes what `init`/`configure` wrote: the `bitrix-mcp` server entry, managed hooks, managed guidance sections and installed skills, leaving your own content intact. Global configs are changed only when their entry points at the current project. Index data and `*.bak` backups are kept.
- **`--no-hooks`** for `init`/`configure` skips writing agent hooks.
- **`--debug`** prints the stack trace on errors.
- **`BITRIX_MCP_HOME_DIR`** overrides the home directory used for global client configs (Windsurf, Cline, Codex, Kilo Code).
- **DB connections:** `.settings_extra.php` is merged over `.settings.php` (as Bitrix does), Unix sockets (`localhost:/run/mysqld/mysqld.sock`) are supported, and legacy cp1251 sites (`utf_mode` false) are read with the right charset. PostgreSQL connections now fail with a clear "not supported yet" error instead of trying MySQL on port 3306.

### Changed

- **CLI (breaking):** arguments are parsed strictly per command with `node:util` `parseArgs`.
  - `<command> --help` / `-h` prints that command's help without running it. Before, `index-code --help` ran a full index and `init --help` wrote client configs.
  - `--opt value` and `--opt=value` both work for every value option. Before, `--modules main,iblock` was silently read as the root path.
  - Unknown options, flags a command does not support (e.g. `status --force`, previously ignored) and extra arguments now fail with exit code 2. Numeric options (`--depth`, `--limit`, `--max-files`, `--max-items`) are validated. Unknown `--agent` ids are an error listing the known ids.
  - `-v`/`--version` only works as a global flag before the command.
- **`init`/`configure` edit client configs surgically.**
  - JSON configs are read as JSONC with `jsonc-parser`: comments, formatting, trailing commas and unrelated keys are preserved. Before, a regex comment stripper corrupted strings such as `"Read(src/**/*.ts)"` (→ `"Read(src*.ts)"`) in `.claude/settings.json` and crashed on trailing commas. An unparsable file stops `init` with an error naming it and is left untouched.
  - The `bitrix-mcp` server entry is merged, not replaced: your own keys (extra env vars, `disabled`, `timeout`, `alwaysAllow`) survive re-runs.
  - A one-time `<file>.bak` is written before the first change to an existing config file; unchanged files are not rewritten.
  - Codex `config.toml` block detection handles `[[array]]` headers, trailing comments and quoted keys, and removes a stale `[mcp_servers.bitrix-mcp.env]` sub-table.
  - Existing user-owned hook files without the bitrix-mcp marker (`.clinerules/hooks/UserPromptSubmit`, `.github/hooks/bitrix-mcp.json`) are skipped with a warning instead of overwritten.
  - `--yes` now says which agent it configured (Cursor), and each config reports created / updated / already up to date.
- **Claude Code hook runs once per session.** The per-prompt `UserPromptSubmit` directive, which added ~150–200 tokens to every prompt, is replaced by a `SessionStart` hook; `SubagentStart` stays and the directive texts are shorter. Re-running `init`/`configure` removes the old managed `UserPromptSubmit` entry.
- **`bitrix_db_query` results:**
  - They are streamed and capped by rows (`limit`, default 500) and by size (about 1 MB), with `truncatedReason: "rows" | "bytes"`. The row `LIMIT` is appended only at the top level and can no longer be swallowed by a trailing `-- comment`.
  - BIGINT/DECIMAL values come back as strings without precision loss, and dates are returned as stored.
  - BLOBs come back as text, or `<binary N bytes: …>` instead of a `{"type":"Buffer","data":[…]}` array.
  - Cells over 4000 characters are truncated.
- **`bitrix_tinker`:**
  - Output over 4 MB kills the process.
  - `output` is truncated at 20k characters, and `returnValue` is omitted above 8k characters (`returnText` is still returned).
  - Timeouts kill the whole process tree: SIGTERM then SIGKILL, or `taskkill /T /F` on Windows, where PHP could previously be orphaned. The PHP timeout is also kept below the worker timeout, so temp files are always removed.
- DB and tinker failures are returned with `isError: true`.

### Fixed

- `bitrix_tinker` snippets that call `exit()`/`die()` now return their output with `exited: true` instead of a `NoOutput` error.
- The `.settings.php` regex fallback now reads only the `connections` section, so a cache or session `host` is no longer mistaken for the database host.

### Dependencies

- Added `jsonc-parser` (runtime).

## 0.6.1

### Added

- **`bitrix_index_all` accepts `includeInstall`.** Module `install/` assets have been opt-in since 0.4.2, but the MCP tool had no way to request them (the CLI already had `--install`). Pass `includeInstall: true` to index them; the default stays `false`.
- **CI.** A GitHub Actions workflow runs typecheck, tests, build and a CLI smoke test on Linux, macOS and Windows with Node 22.12, 22 and 24.
- `npm run test:integration` runs the network-dependent Bitrix core checkout test on demand.

### Fixed

- **The `node:sqlite` `ExperimentalWarning` no longer leaks to stderr.** Every CLI command, the MCP server and its worker threads printed `ExperimentalWarning: SQLite is an experimental feature…`, which broke `--json-progress` (stderr was no longer pure JSON Lines) and cluttered MCP client logs. The CLI, worker-thread and child-process entry points now install a filter for that one warning before loading `node:sqlite`; all other warnings are still printed.
- **The MCP server reports its real version.** `serverInfo.version` was hardcoded to `0.1.0`; it is now read from `package.json`, like `--version`.
- `package-lock.json` is back in sync with `package.json`; it had been left at 0.4.8.

### Changed

- **The Bitrix core integration test is opt-in and pinned.** It cloned the latest `autrobin/bitrix.core` and ran its `update.sh` with the caller's full environment on every `npm test` — including `prepublishOnly`, where npm credentials are present. It now runs only with `BITRIX_MCP_INTEGRATION=1`, checks out a pinned commit, and gives the script a minimal environment (`HOME`, `PATH`). Its stale "install assets are indexed by default" expectation was also fixed.
- The `npm test` glob is now quoted, so Node expands it instead of the shell. Without quotes, adding a test in a `tests/` subfolder would make `sh` expand the pattern to that folder only and silently skip every top-level test.

### Documentation

- `docs/security.md`, `docs/configuration.md` and both READMEs no longer claim that passwords are never returned or that the DB tools cannot modify data. The `bitrix_db_query` read-only check is a keyword filter, not a security boundary (`WITH … DELETE`, `SELECT … INTO OUTFILE` and `LOAD_FILE` pass it), and `bitrix_read_file_context`, `bitrix_db_query` and `bitrix_tinker` can still read secrets. The docs now say so and recommend a `SELECT`-only DB account. They also state that `init` enables DB access by default even though the server's own default is off.
- The `bitrix_index_all` description, `docs/tools.md`, `docs/indexing.md` and CLI help no longer say install assets are indexed by default.
- `docs/release.md` adds the version-sync, tagging and CI steps.

## 0.6.0

### Added

- **`bitrix_tinker` — run PHP with the Bitrix kernel loaded (opt-in).** A new MCP tool that bootstraps `bitrix/modules/main/include/prolog_before.php` in a PHP CLI subprocess and executes arbitrary PHP with full D7 API, ORM, `Loader::includeModule`, and `Option::get` available — the runtime analog of Laravel Tinker. Return a value with a top-level `return <expr>;`; echoed output, thrown exceptions, and PHP fatal errors are captured structurally. Gated behind `BITRIX_MCP_TINKER_ENABLED=1` (off by default) with `BITRIX_MCP_PHP_BIN` selecting the PHP binary (default `php`; should match the site's PHP version and extensions). This is full code execution and write access on the local machine and bypasses the `bitrix_db_query` read-only guard entirely — intended for a trusted local development environment only. `init` asks whether to enable it (default no); `--tinker` enables it non-interactively. When tinker is enabled, `init` auto-detects the PHP CLI binary (PATH, then Herd/Laragon/XAMPP/OpenServer), lets you confirm or override it interactively or via `--php-bin <path>`, and writes `BITRIX_MCP_PHP_BIN` into the config only for tinker-enabled setups.

## 0.5.0

### Added

- **Live project database access (opt-in).** New MCP tools query the running project's MySQL database, reading connection credentials from `bitrix/.settings.php`: `bitrix_db_connections` (lists connections with passwords redacted), `bitrix_db_schema` (tables/columns via `information_schema`), and `bitrix_db_query` (read-only SQL — only `SELECT`/`SHOW`/`EXPLAIN`/`DESCRIBE`/`WITH`, multi-statement rejected, results row-limited). All are gated behind `BITRIX_MCP_DB_ENABLED=1` and off by default. Writes are a separate opt-in: `BITRIX_MCP_DB_ALLOW_WRITE=1` additionally registers `bitrix_db_execute` for `INSERT`/`UPDATE`/`DELETE`. Passwords are never returned by any tool. Intended for a local development database. `init` now asks whether to enable DB access (default yes) and whether to allow writes (default no); `--no-db` and `--db-allow-write` control it non-interactively.

## 0.4.8

### Added

- **`status` now breaks files and symbols down by scope and language.** `bitrix-mcp status` (and the JSON it emits, plus the `bitrix_index_status` MCP tool) previously reported only aggregate totals, so a scope that indexed zero JavaScript was invisible behind a single `Files: N`. It now also prints `by scope` (project/template/bitrix/install) and `by language` (php/javascript/typescript/…) tallies for files, and a `by language` tally for symbols — making JS/TS coverage (or its absence on a stale index) obvious at a glance.

### Fixed

- **`typescript` is now a runtime dependency instead of a dev dependency.** The LiveAPI indexer (`liveapi/jsParser`) imports the TypeScript compiler to parse JS/TS symbols, so it is required at runtime. With it under `devDependencies`, a global/production install (`npm install -g`, `npx`) did not pull it in, and the first indexing pass crashed with `Cannot find module 'typescript'` — most visible on clean Windows machines with no globally installed TypeScript. It now ships as a regular dependency and installs out of the box.
- **Windows: generated MCP configs launch the server through `cmd /c`.** On Windows the global install is a set of npm shims (`bitrix-mcp.cmd` / `.ps1`), not a real executable. MCP clients that spawn without a shell could not resolve the bare `bitrix-mcp` command (`ENOENT`), and PowerShell prefers the `.ps1` shim, which the default execution policy blocks. `init`/`configure` now write `command: "cmd", args: ["/c", "bitrix-mcp", "serve", …]` on `win32` (all clients, including the Codex TOML block), so the client launches the policy-immune `.cmd` shim via PATHEXT. macOS/Linux configs are unchanged (`command: "bitrix-mcp"`).

### Changed

- **Indexing exclusions tightened for JS-heavy Bitrix trees.** `test/**` directories and `*.test.js` files are now excluded from every scope (test scaffolding, not API surface), and the `index-install` scope skips `install/js/**` because a module's install JS is copied verbatim into the published `bitrix/js` tree on install — indexing both duplicated the same symbols under two kinds. Authored `src/**` next to a `dist/**` bundle is still indexed (the transpiled bundle yields no usable class symbols, so `dist/` stays excluded as before). Re-run `bitrix-mcp index-bitrix --force` to pick up core JS (e.g. `bitrix/js/ui/entity-selector/src/**`) on indexes built before `bitrix/js` coverage existed.

### Documentation

- Added a Windows / PowerShell troubleshooting note (README, ru.README, `docs/cli.md`) for the `bitrix-mcp.ps1 cannot be loaded because running scripts is disabled on this system` (`PSSecurityException`) error. This is the Windows script execution policy blocking npm's PowerShell shim, not a package fault; documented the `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` fix and the `npx` / `bitrix-mcp.cmd` alternatives.

## 0.4.7

### Added

- `init`/`configure` now writes agent hooks that actively push a "use bitrix-mcp first" directive, so the server is used automatically instead of waiting to be asked. Passive skill/rule guidance is not always enough — Claude Code in particular defers MCP tools behind its `ToolSearch` mechanism. Hooks are written for every agent that supports prompt/session context injection, using each agent's verified schema and an agent-appropriate directive (only Claude Code gets a `ToolSearch` step; every other agent exposes MCP tools directly):
  - **Claude Code** — `<project>/.claude/settings.json`: `UserPromptSubmit` (main thread) and `SubagentStart` (spawned subagents).
  - **Gemini CLI** — `<project>/.gemini/settings.json`: `BeforeAgent` (Gemini has no subagent-start event).
  - **Cursor** — `<project>/.cursor/hooks.json`: `sessionStart` via `additional_context` (Cursor's `beforeSubmitPrompt` cannot inject context).
  - **OpenAI Codex** — `<project>/.codex/hooks.json`: `SessionStart` via `hookSpecificOutput.additionalContext`.
  - **GitHub Copilot / VS Code** — `<project>/.github/hooks/bitrix-mcp.json` (auto-loaded): `SessionStart` via `hookSpecificOutput.additionalContext`.
  - **Cline** — `<project>/.clinerules/hooks/UserPromptSubmit`: an executable `bash` script emitting `{"contextModification": ...}` (Cline's hook mechanism is script files, macOS/Linux only).
  - Agents that do **not** expose a prompt/session context-injection hook keep relying on their always-applied rule files (which `init` already writes): **Windsurf** (hooks only block actions via exit codes), **Roo Code** (prompt hooks not yet available), **Kilo Code** (hooks are code plugins, not declarative config), **Continue** (rules + context providers only), and **JetBrains / Junie** (no declarative hooks).

  JSON hook writes merge into any existing config (user settings and other hooks/servers are preserved) and are idempotent — managed hooks carry a `bitrix-mcp:auto-directive` marker and are replaced in place on re-runs.

## 0.4.6

### Removed

- Removed the "Claude Desktop (global)" init agent. The modern Claude Desktop rewrites its global `claude_desktop_config.json` and does not reliably persist the `mcpServers` entry; the integrated app reads the project `.mcp.json` instead. Use the `claude-code` agent for Claude Desktop (its menu entry notes this). The agent is gone from the init menu, `--agent` IDs, `--all-agents`, and the `config`/`doctor` MCP-config-files report.

## 0.4.5

### Changed

- `init` no longer starts the MCP stdio server by default. The MCP config it writes already launches `bitrix-mcp serve` from the client, so the client starts the server itself — init starting its own blocking server was redundant and looked like a hang. Pass `--serve` to start it immediately; `--no-serve` is kept as a no-op for compatibility.

### Added

- For Claude Code / Claude Desktop agents, `init` now installs the skill into `<project>/.claude/skills/bitrix-mcp/SKILL.md` (the folder is created if missing) so it is auto-discovered, in addition to the canonical `.bitrix-mcp/skills/` copy. (The `.mcp.json` MCP config was already created/merged, preserving other servers.)

## 0.4.4

### Changed

- Clearer `init` output so it is obvious when indexing has finished. After all scopes (and docs) are indexed, init now prints `✓ Bitrix MCP is configured and indexing is complete.`; documentation indexing prints a "started" line instead of running silently; and the stdio server start message now explains that the server keeps running and waits for the MCP client (it is not frozen — Ctrl+C to stop, or use `--no-serve`).

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
