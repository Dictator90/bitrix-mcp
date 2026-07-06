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
| `init [options]` | Configure MCP clients + guidance and build initial indexes. The MCP client starts the server; use `--serve` to start it now. See [configuration.md](./configuration.md). |
| `configure [options]` | Configure MCP clients and guidance only — no indexing, no server. |
| `config [--json]` | Print resolved runtime paths and which MCP client config files exist. |
| `serve` | Start the MCP server over stdio. |
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
| `status` | Show the SQLite DB path and index counters. |
| `doctor [--json] [--verbose]` | Health check for workspace, Bitrix root, SQLite, docs, ignore file, and embeddings. |
| `detect-changes [--base <ref>] [--json] [--depth <n>]` | Analyze Git-changed Bitrix files, indexed entities, and impact. |
| `graph-neighbors <type> <name> [--direction out\|in\|both] [--relation-type <t>] [--depth <n>] [--json]` | Query the dependency graph. See [graph.md](./graph.md). |
| `impact-radius [file ...] [--base <ref>] [--depth <n>] [--json]` | Analyze graph impact radius. |
| `benchmark [--force]` | Write `.bitrix-mcp/benchmark.json` and `benchmark.md`. See [benchmarks](#benchmarks). |

Global options: `--version`/`-v`, `--help`/`-h`.

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
- `lang/**` message files — excluded across **all** scopes (re-enable with `--include-lang` / `--full`)

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
