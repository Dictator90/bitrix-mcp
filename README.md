# Bitrix MCP

[Русская документация](./ru.README.md)

A local, token-free [MCP](https://modelcontextprotocol.io) server that indexes your **Bitrix Framework / 1C-Bitrix** project — PHP sources, templates, modules, install assets, and docs — so an AI assistant can search real project symbols and documentation. No Bitrix module to install, no runtime changes, no API token.

Works with any MCP-capable assistant: Cursor, Claude Code, Claude Desktop, PhpStorm/JetBrains AI, VS Code / GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Gemini CLI, OpenAI Codex, and Kilo Code.

## What it does

- **LiveAPI & symbol search** — find functions, classes, methods, events, components, constants, and module include/check usage across your project and the Bitrix core.
- **Project, template & core indexing** — index your own code, templates/components, and the Bitrix core separately and incrementally.
- **Documentation search** — local Bitrix Framework docs as MCP resources, searched with SQLite full-text search (optional semantic search via a Python service).
- **Dependency graph & impact radius** — query a Bitrix-aware graph of events, handlers, modules, agents, ORM entities, components, iblocks, options, and inheritance; see what a change affects.
- **Local & private** — no token or Bitrix auth; access is just which local folders you expose.

## Requirements

- Node.js **22.12+** (uses `node:sqlite`) and npm **10+**.
- Linux, macOS, or Windows.
- Disk access to the Bitrix project you want to index.
- Network access for the first docs index (clones the official Bitrix docs; can be disabled).
- Python **3.11+** only for optional semantic search.

## Install

```bash
npm install -g @mb4it/bitrix-mcp
# or run without installing:
npx @mb4it/bitrix-mcp init
```

### Windows / PowerShell

If PowerShell refuses to run the global `bitrix-mcp` command with
`cannot be loaded because running scripts is disabled on this system`
(`UnauthorizedAccess` / `PSSecurityException`), that is the Windows script
**execution policy** blocking npm's `bitrix-mcp.ps1` shim — not a problem with
this package. Pick one:

```powershell
# Recommended: allow local/signed scripts for your user (persistent, one-time)
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Or bypass without installing / without changing policy:
npx @mb4it/bitrix-mcp init

# Or call the .cmd shim explicitly (works under the Restricted policy):
bitrix-mcp.cmd init
```

## Quick start

From the root of your Bitrix project:

```bash
# Configure your MCP client and build initial indexes.
# The client launches the server itself, so init doesn't start it.
npx @mb4it/bitrix-mcp init --agent cursor
```

`init` picks the current directory as the project root, configures the selected client(s), writes guidance/rule files, and indexes your project, templates, Bitrix core (if a local `bitrix/` exists), and docs. Run it interactively to choose multiple clients, or pass `--agent <id>` / `--all-agents` / `--yes`.

Then open your AI client and ask it to use Bitrix MCP. A good first prompt:

```text
Use Bitrix MCP to check index status, then find how this project registers sale module event handlers.
```

## Everyday commands

```bash
bitrix-mcp index-all      # reindex everything: project, templates, core, install, docs
bitrix-mcp index-code     # reindex code only (no docs)
bitrix-mcp serve          # start the MCP server (your client normally does this)
bitrix-mcp status         # index counters and DB path
bitrix-mcp doctor         # health check and resolved paths
```

Index only specific Bitrix core modules for a much faster run:

```bash
bitrix-mcp index-bitrix --modules=main,iblock,sale,catalog
```

Skip the official docs download (offline / CI / first-run demos):

```bash
BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0 bitrix-mcp index-all
```

→ Full command list, flags, and progress options: **[docs/cli.md](./docs/cli.md)**.

## How an AI agent should use it

Treat non-empty MCP results as authoritative for project symbols, framework APIs, event handlers, ORM entities, and docs. Fall back to manual `grep`/file reads only when MCP returns nothing, reports a stale index, or you ask for a manual check. This saves tokens and avoids hallucinations from partial file scans. (`init` writes this guidance into each client's rule file automatically.)

Recommended flow: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_docs_search` → `bitrix_read_file_context` / `bitrix_read_symbol_context`.

## MCP tools

Grouped overview (full reference with parameters and examples in **[docs/tools.md](./docs/tools.md)**):

- **Index / status** — `bitrix_index_project`, `bitrix_index_template`, `bitrix_index_all`, `bitrix_index_docs`, `bitrix_index_status`
- **Symbol & LiveAPI search** — `bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_module_usage_search`, `bitrix_inheritance_search`
- **Source context** — `bitrix_read_file_context`, `bitrix_read_symbol_context`
- **Components & ORM** — `bitrix_component_search`, `bitrix_component_context`, `bitrix_orm_search`, `bitrix_orm_entity_map`, `bitrix_orm_usage_search`
- **IBlock / HLBlock / Options / Agents / Mail** — `bitrix_iblock_usage_search`, `bitrix_hlblock_usage_search`, `bitrix_option_search`, `bitrix_agent_search`, `bitrix_mail_event_search`
- **Graph & impact** — `bitrix_relation_search`, `bitrix_graph_neighbors`, `bitrix_graph_traverse`, `bitrix_impact_radius`, `bitrix_detect_changes`
- **Docs** — `bitrix_docs_search`, `bitrix_docs_for_symbol`, `bitrix_explain_api_usage`, and optional `bitrix_semantic_docs_search`
- **Overview / autoload** — `bitrix_project_overview`, `bitrix_autoload_search`

## Configuration

Common settings are environment variables — paths, the Bitrix root, official docs, and semantic search. `init` writes the ones your client needs into its MCP config.

```bash
BITRIX_ROOT                       # Bitrix project root for core indexing
BITRIX_MCP_DATA_DIR               # where indexes are stored (default .bitrix-mcp)
BITRIX_MCP_OFFICIAL_DOCS_ENABLED  # 0 to skip the official docs repo
BITRIX_MCP_SEMANTIC_ENABLED       # 1 to enable semantic docs search
```

→ All variables, the per-client config table, `init`/`configure` flags, and troubleshooting: **[docs/configuration.md](./docs/configuration.md)**.

## Documentation

- **[CLI reference](./docs/cli.md)** — every command, Bitrix core indexing, flags, progress.
- **[Configuration](./docs/configuration.md)** — env vars, client setup, troubleshooting.
- **[MCP tools](./docs/tools.md)** — parameters, examples, result formats, limits.
- **[Indexing](./docs/indexing.md)** — scopes and storage.
- **[Dependency graph](./docs/graph.md)** — relations, neighbors, traversal, impact radius.
- **[Detect changes](./docs/detect-changes.md)** — review workflow.
- **[Bitrix events](./docs/bitrix-events.md)** · **[ORM](./docs/orm.md)** · **[Components](./docs/components.md)** — per-topic workflows.
- **[Docs search & embeddings](./docs/embeddings.md)** — FTS and the optional Python service.
- **[Security](./docs/security.md)** — local data, path restrictions, network notes.
- **[Example prompts](./docs/examples.md)** — copy-ready prompts.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## License

[MIT](./LICENSE)
