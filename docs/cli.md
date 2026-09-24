# CLI reference

All commands run as `bitrix-mcp <command>` (or `npx @mb4it/bitrix-mcp <command>`).
Run `bitrix-mcp --help` for the built-in summary.

> **Windows / PowerShell:** if a command fails with `bitrix-mcp.ps1 cannot be
> loaded because running scripts is disabled on this system`
> (`PSSecurityException`), the Windows execution policy is blocking npm's
> PowerShell shim. Fix it once with
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, or use
> `npx @mb4it/bitrix-mcp <command>` / `bitrix-mcp.cmd <command>` instead.

## Commands

| Command | What it does |
| --- | --- |
| `init [options]` | Configure MCP clients + guidance and build initial indexes. The MCP client starts the server; use `--serve` to start it now. `--dry-run` previews the file changes. See [configuration.md](./configuration.md). |
| `configure [options]` | Configure MCP clients and guidance only — no indexing, no server. `--dry-run` previews the file changes. |
| `uninstall [--agent <id>] [--all-agents] [--dry-run]` | Remove what `init`/`configure` wrote: the `bitrix-mcp` server entry in each client config, managed hooks, managed guidance sections, and installed skills. See [configuration.md](./configuration.md#bitrix-mcp-uninstall). |
| `config [--json]` | Print resolved runtime paths and which MCP client config files exist. |
| `serve` | Start the MCP server over stdio. |
| `watch [options]` | Watch the workspace (and Bitrix root) and incrementally re-index changed files until Ctrl+C. See [Watch mode](#watch-mode). |
| `clean [--dry-run] [--yes] [--all]` | Delete the index data in the data directory. See [Cleaning index data](#cleaning-index-data). |
| `index-all [--force]` | Index project, templates, Bitrix core, install assets, and docs. |
| `index-code [--force]` | Index project, templates, Bitrix core, and install assets (no docs). |
| `index-project [root] [--force]` | Index your project's own files (never crawls `/bitrix/`). |
| `index-template [path] [--force]` | Index a template path, or standard template locations. |
| `index-bitrix [root] [options]` | Index the Bitrix core. See [Bitrix core indexing](#bitrix-core-indexing). |
| `index-install [root] [--force]` | Index Bitrix module install assets. |
| `docs-add-git [url]` | Register a Git docs source (defaults to the official Bitrix docs). |
| `docs-add-path <path>` | Register a local documentation directory. |
| `docs-update` | Clone or pull registered Git docs sources. |
| `index-docs [--force] [--embeddings]` | Index registered docs into SQLite, optionally into embeddings. |
| `index-embeddings` | Send SQLite doc chunks to the embeddings service. See [embeddings.md](./embeddings.md). |
| `search-modules <module>` | Search indexed Bitrix module include/check API usages. |
| `status` | Show the SQLite DB path and index counters, broken down by scope (project/template/bitrix/install) and language (php/javascript/typescript/…). |
| `doctor [--json] [--verbose]` | Health check for workspace, Bitrix root, SQLite, docs, ignore file, and embeddings. |
| `detect-changes [--base <ref>] [--json] [--depth <n>]` | Analyze Git-changed Bitrix files, indexed entities, and impact. |
| `graph-neighbors <type> <name> [--direction out\|in\|both] [--relation-type <t>] [--depth <n>] [--json]` | Query the dependency graph. See [graph.md](./graph.md). |
| `impact-radius [file ...] [--base <ref>] [--depth <n>] [--json]` | Analyze graph impact radius. |
| `benchmark [--force]` | Write `.bitrix-mcp/benchmark.json` and `benchmark.md`. See [benchmarks](#benchmarks). |

Global options (before the command): `--version`/`-v`, `--help`/`-h`, `--debug`.

## Argument parsing

- `bitrix-mcp <command> --help` (or `-h`) prints that command's options and exits `0` **without running it** — e.g. `index-code --help` does not index and `init --help` writes nothing.
- Value options accept both forms: `--modules main,iblock` and `--modules=main,iblock` (same for `--agent`, `--base`, `--depth`, `--limit`, `--php-bin`, …).
- Options are validated per command: an unknown option (or a flag a command does not support, e.g. `status --force`) or an unexpected extra argument prints an error and exits with code `2`.
- `--depth`, `--limit`, `--max-files`, and `--max-items` must be integers (`--depth` ≥ 0, the others ≥ 1).
- `-v`/`--version` is only recognized as a global flag before the command.
- On failure the CLI prints `Error: <message>` and exits non-zero (`2` for usage errors, `1` otherwise). Add `--debug` to also print the stack trace.

## Bitrix core indexing

The Bitrix core (`/bitrix/`) is large, so its indexing is curated and controllable.

The `bitrix` scope (`index-bitrix`, and the Bitrix part of `index-code` / `index-all`) indexes:

- `bitrix/modules/**/*.php` — module PHP (classes, ORM, events, API usages)
- `bitrix/admin/**/*.php` and `bitrix/tools/**/*.php`
- `bitrix/js/**` and `local/js/**` — core JS
- `local/modules/**/*.php` — your custom modules

Excluded by default (always):

- runtime/cache/generated: `bitrix/cache`, `managed_cache`, `html_pages`, `upload`, …
- static assets: `bitrix/images`, `themes`, `fonts`, `panel`, …
- `bitrix/wizards/**`
- module `install/**` (that is the separate `index-install` scope)
- `dist/**` built bundles — the transpiled bundle yields no usable class symbols; the authored `src/` next to it (e.g. `bitrix/js/ui/entity-selector/src/**`) is indexed instead
- `test/**` directories and `*.test.js` files — test scaffolding, not API surface (excluded across **all** scopes)
- `lang/**` message files — excluded across **all** scopes (re-enable with `--include-lang` / `--full`)

The `index-install` scope additionally skips `install/js/**`: a module's install JS is copied verbatim into the published `bitrix/js` tree when it installs, so it is already covered by the bitrix scope and indexing it again would duplicate the same symbols under two kinds.

Components and templates belong to the **template** scope (`bitrix/components`, `bitrix/templates`, and `local/` equivalents). The **project** scope (`index-project`) indexes your own code only and never crawls `/bitrix/`.

```bash
# Whole core, all modules, no lang (default)
bitrix-mcp index-bitrix

# Only specific modules — much faster on a real project
bitrix-mcp index-bitrix --modules=main,iblock

# Online store
bitrix-mcp index-bitrix --modules=main,iblock,sale,catalog,currency

# Every module + lang files (slow; prints a warning)
bitrix-mcp index-bitrix --full

# Dry run: show what would be indexed without indexing
bitrix-mcp index-bitrix --plan --modules=main,iblock

# index-code / index-all: skip the core, or narrow it
bitrix-mcp index-all --no-bitrix
bitrix-mcp index-all --bitrix-modules=main,iblock
```

### Flags

| Flag | Applies to | Effect |
| --- | --- | --- |
| `--modules=main,iblock` | `index-bitrix` | Index only these core modules (default `all`). `--modules=all` for every module. |
| `--bitrix-modules=…` | `index-code`, `index-all` | Same selection for the Bitrix part of those commands. |
| `--full` | `index-bitrix`, `index-code`, `index-all` | Every module **plus** `lang/` and install assets. Alias for `--modules=all --include-lang --install`. Prints a slow-run warning. |
| `--include-lang` | all Bitrix index commands | Include `lang/` message files (off by default). |
| `--install` | `index-code`, `index-all` | Also index module `install/` assets (off by default). |
| `--no-bitrix` | `index-code`, `index-all` | Skip the Bitrix core and install scopes entirely. |
| `--plan` | `index-bitrix` | Print the indexing plan and exit without indexing. |

Unknown module names print a warning and are skipped; the run continues as long as at least one requested module exists.

### Incremental reindex

Reindexing is incremental: a file is re-parsed only when its size or mtime changed since the last run. Unchanged files are skipped, deleted files are removed. The first `index-bitrix` is the slow one; later runs are fast. `.bitrixmcpignore` rules apply on top of the built-in ignores.

## Watch mode

`bitrix-mcp watch` keeps the index current while you edit: it watches the workspace (plus `BITRIX_ROOT` when it lies outside the workspace) and re-indexes each debounced batch of changes. Run `index-code` (or `init`) once first — `watch` only reacts to changes made while it runs.

```bash
bitrix-mcp watch                       # project, templates, Bitrix core
bitrix-mcp watch --no-bitrix           # your code only
bitrix-mcp watch --docs                # also re-index documentation directories
bitrix-mcp watch --modules=main,iblock --install   # match how you indexed the core
bitrix-mcp watch --json                # one JSON object per event
```

Each changed path is mapped to its scope with the same include/ignore rules as indexing (built-in ignores, `lang/` exclusion, `.gitignore` for project/template, `.bitrixmcpignore`, the Bitrix core allowlist, and the module selection). Paths no scope indexes — `.bitrix-mcp/`, `.git/`, `node_modules/`, `bitrix/cache`, `upload/`, images, … — are ignored. Each batch then re-runs the incremental indexer on the smallest unit that contains the change:

| Change under | Re-indexed |
| --- | --- |
| `local/templates/<name>/`, `bitrix/templates/<name>/` | that site template directory (template scope) |
| `local/components/<ns>/<name>/`, `bitrix/components/<ns>/<name>/` | that component directory (template scope) |
| `bitrix/modules/<m>/`, `local/modules/<m>/` (PHP) | that module (bitrix scope; `install/` excluded) |
| `bitrix/admin/`, `bitrix/tools/` | that directory (bitrix scope) |
| `bitrix/js/<ext>/`, `local/js/<ext>/` | that extension (bitrix scope) |
| `<module>/install/` (with `--install`) | that module's `install/` (install scope; `install/js` excluded) |
| anything else indexed | the project scope (incremental: unchanged files are only stat-ed) |
| documentation directories (with `--docs`) | the registered docs sources |

Deleted files and directories are pruned from the index. Editing the root `.gitignore` / `.bitrixmcpignore` re-runs the project and template scopes.

Output is one line per re-index run, e.g. `[12:30:18] template local/templates/main: local/templates/main/header.php -> 1 parsed, 12 unchanged (9 ms)`. With `--json` every event is a JSON object on its own line: `ready` (roots, scopes), `reindex` (`scope`, `path`, `changed`, `files`, `parsedFiles`, `unchangedFiles`, `warnings`, `elapsedMs`, `docChunks` for docs), `error`, and `stopped`. Ctrl+C stops after the current run finishes (a second Ctrl+C exits immediately).

| Flag | Effect |
| --- | --- |
| `--no-bitrix` | Do not watch or re-index the Bitrix core / install scopes. |
| `--modules=…`, `--include-lang`, `--install`, `--full` | Same meaning as for `index-code`. Use the options you indexed with, otherwise a re-index of a module prunes files the full run kept (e.g. `lang/` files). |
| `--docs` | Also watch the documentation directories (`BITRIX_MCP_DOCS_PATHS` / `docs/`) and re-index docs on change. Remote doc checkouts are not pulled. |
| `--debounce <ms>` | Quiet period before a batch is re-indexed (default `500`). |
| `--json` | JSON Lines output. |

Notes:

- On Linux, `watch` adds one inotify watch per relevant directory and never descends into ignored trees. On a very large core you may need to raise `fs.inotify.max_user_watches` (the error message says so). macOS and Windows use a single recursive watcher per root.
- A directory-level re-index reads `.gitignore` / `.bitrixmcpignore` from that directory, not from the project root (as `index-template <path>` does); root rules are applied to the changed path itself. Run `index-code` occasionally for a full pass with the root rules.
- A module-level re-index records only that module's parse warnings in the scope's index metadata; `index-code` restores the full picture.

## Cleaning index data

`bitrix-mcp clean` deletes the index data from the data directory (`.bitrix-mcp/` or `BITRIX_MCP_DATA_DIR`):

- the SQLite index `bitrix-mcp.sqlite` and its `-wal` / `-shm` / `-journal` files;
- legacy JSON indexes (`*-index.json`);
- benchmark reports (`benchmark.json`, `benchmark.md`);
- with `--all`, also the `docs-sources/` documentation checkouts.

Generated skills/rules and any other files in the data directory are kept, and nothing outside the data directory is ever removed.

```bash
bitrix-mcp clean --dry-run   # list what would be removed, with sizes
bitrix-mcp clean             # asks for confirmation in a terminal
bitrix-mcp clean --yes       # no prompt (required when stdin is not a terminal)
bitrix-mcp clean --all --yes # also delete the docs checkouts
```

Registered documentation sources are stored in the SQLite index: `index-docs` re-registers the official docs and `BITRIX_MCP_DOCS_PATHS`; re-add custom ones with `docs-add-git` / `docs-add-path`. On Windows, stop running MCP servers first: open database files cannot be deleted there.

## Indexing progress

Every `index-*` command shows progress while it works.

```bash
bitrix-mcp index-bitrix              # live progress in an interactive terminal (default)
bitrix-mcp index-bitrix --compact    # dots for work, checkmarks for completed phases
bitrix-mcp index-all --no-progress   # disable progress entirely
bitrix-mcp index-bitrix --progress   # force progress on a non-interactive shell
bitrix-mcp index-bitrix --json-progress  # JSON Lines events to stderr
```

- Progress is on by default in an interactive terminal and off in CI/non-TTY.
- It is always written to **stderr**, so it never interferes with the `serve` stdio protocol or piped output.
- If `NO_COLOR` is set (or the terminal lacks unicode), the reporters fall back to ASCII marks.

## Benchmarks

```bash
npm run benchmark   # from this repo
bitrix-mcp benchmark  # from an installed package
```

Reports are written to `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md`. The benchmark measures incremental indexing across scopes, docs/LiveAPI/event/relation search, graph traversal, impact-radius, detect-changes, plus DB size and indexed counts. It skips missing Bitrix roots and docs with warnings and does not force a full reindex unless `--force` is passed.
