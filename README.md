# Bitrix MCP

[Русская документация](./ru.README.md)

Bitrix MCP is a local, token-free MCP server for AI assistants that work with **Bitrix Framework / 1C-Bitrix** projects. It indexes your project, templates, Bitrix modules, install assets, and documentation so an AI agent can search real project symbols and docs without installing a Bitrix module or changing the runtime.

## Who this is for

Use Bitrix MCP when you want an MCP-capable assistant such as Cursor, Claude Desktop, Claude Code, PhpStorm / JetBrains AI Assistant, VS Code / GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Gemini CLI, OpenAI Codex, or Kilo Code to answer questions about a local Bitrix project, find framework APIs, inspect event handlers, or work with templates using indexed local context.

## Capabilities

- **LiveAPI search**: indexes PHP sources from an installed Bitrix instance and searches functions, classes, methods, events, components, constants, and Bitrix module include/check usage records.
- **Project indexing**: indexes the current project from a terminal command or MCP tool.
- **Template indexing**: separately indexes templates, components, scripts, styles, and layout assets.
- **Documentation search**: exposes local Bitrix Framework documentation as MCP resources and searches indexed Markdown/text docs with SQLite FTS.
- **Optional semantic documentation search**: delegates embedding search to a Python `sentence-transformers` FastAPI service when explicitly enabled.
- **Bitrix dependency graph**: queries `bitrix_relations` as a Bitrix-aware graph of events, handlers, modules, agents, mail events, ORM entities, components, templates, iblocks, hlblocks, options, and inheritance.
- **Local access model**: no token or Bitrix authentication is required; access is controlled by where you run the process and which local folders you expose.

## System requirements

- Operating system: Linux, macOS, or Windows / Windows PowerShell.
- Node.js **22.12+** because Bitrix MCP uses `node:sqlite`.
- npm **10+**.
- Disk access to the Bitrix project you want to index.
- Network access is recommended for the first documentation index because the official Bitrix Framework docs repository is cloned or updated by default.
- Python **3.11+** is required only for optional semantic documentation search.

The server uses `@modelcontextprotocol/sdk` **v1.29.0**.

## Dependencies

Runtime dependencies are installed by `npm install` and include:

- `@modelcontextprotocol/sdk` — MCP server protocol support.
- `fast-glob`, `ignore` — file discovery and ignore handling.
- `php-parser` — PHP symbol parsing for Bitrix and project sources.
- `zod` — schema validation.

Optional semantic search dependencies live in `embeddings/requirements.txt` and are installed only if you run the Python embeddings service.

## Installation from npm

Install globally:

```bash
npm install -g @mb4it/bitrix-mcp
```

Or run without a global install:

```bash
npx @mb4it/bitrix-mcp init --agent cursor --no-serve
```

The installed CLI command remains `bitrix-mcp`:

```bash
bitrix-mcp --help
bitrix-mcp init --agent cursor --no-serve
bitrix-mcp index-all
bitrix-mcp serve
```

## MCP result authority

Bitrix MCP provides deep, specialized indexing of the Bitrix Framework and your project code. When using an AI assistant with Bitrix MCP:

- **Primary Source of Truth**: Treat MCP tool results as authoritative for project symbols, framework APIs, event handlers, ORM entities, and documentation.
- **Manual Search as Fallback**: AI agents are instructed to search files manually or use \`grep\` only when MCP tools return no results, indicate a stale index, or when you explicitly ask for a manual check.
- **Authority Rule**: Successful, non-empty MCP results should not be contradicted by unindexed manual assumptions.

This behavior reduces token waste and prevents the assistant from hallucinating based on incomplete manual file scans.

## Quick start

From the root of your Bitrix project:

```bash
# 1. Install the package dependencies if you use a local checkout of this repo
npm install
npm run build

# 2. Go to the Bitrix project you want to index
cd /path/to/bitrix/project

# 3. Configure your MCP client and create .bitrix-mcp indexes
# In CI or scripts, --no-serve avoids taking over stdio after setup.
npx @mb4it/bitrix-mcp init --agent cursor --no-serve
```

During interactive `init`, select one or more AI agents from the prompt. For non-interactive setup, pass `--agent <id>` (repeat or comma-separate IDs), `--all-agents`, or `--yes` for the default Cursor setup. Bitrix MCP writes or updates the selected agents' MCP configuration, creates reusable guidance/rule files, builds initial indexes, and starts the MCP server over stdio unless `--no-serve` is passed or a CI environment is detected.

After setup, open your AI client and ask it to use Bitrix MCP. A good first prompt is:

```text
Use Bitrix MCP to check index status, then find how this project registers sale module event handlers.
```

If you only need to run or refresh indexes manually:

```bash
# Index everything: project, templates, Bitrix modules, install assets, and docs
npx @mb4it/bitrix-mcp index-all

# Show index counters, resolved runtime paths, and diagnostics
npx @mb4it/bitrix-mcp status
npx @mb4it/bitrix-mcp config
npx @mb4it/bitrix-mcp doctor

# Start the MCP server after indexes already exist
npx @mb4it/bitrix-mcp serve
```

## CLI usage

```bash
# Configure an agent, create .bitrix-mcp indexes, and start stdio server
npx @mb4it/bitrix-mcp init

# Non-interactive init for scripts/CI: configure Cursor, skip serving after setup
npx @mb4it/bitrix-mcp init --agent cursor --no-serve

# Configure MCP config and guidance only; do not index or start the server
npx @mb4it/bitrix-mcp configure --agent cursor

# Start MCP server over stdio for Cursor, PhpStorm, Claude Desktop, Kilo, etc.
npx @mb4it/bitrix-mcp serve

# Index everything: project, templates, Bitrix modules, install assets, and docs
npx @mb4it/bitrix-mcp index-all

# Index all code scopes without documentation
npx @mb4it/bitrix-mcp index-code

# Index the current project
npx @mb4it/bitrix-mcp index-project /path/to/project

# Index templates/components/scripts/styles separately
npx @mb4it/bitrix-mcp index-template /path/to/project

# Index installed Bitrix Framework PHP sources for LiveAPI
cd /path/to/bitrix/project
npx @mb4it/bitrix-mcp index-bitrix

# Index Bitrix module install assets
npx @mb4it/bitrix-mcp index-install /path/to/project

# Register, update, and index documentation sources
npx @mb4it/bitrix-mcp docs-add-git https://github.com/bitrix-tools/framework-docs.git
npx @mb4it/bitrix-mcp docs-add-path /path/to/local/docs
npx @mb4it/bitrix-mcp docs-update
npx @mb4it/bitrix-mcp index-docs

# Send SQLite documentation chunks to the embeddings service
npx @mb4it/bitrix-mcp index-embeddings
# Or reindex SQLite docs and embeddings together when the service is running
npx @mb4it/bitrix-mcp index-docs --embeddings

# Search indexed Bitrix module include/check API usages by module
npx @mb4it/bitrix-mcp search-modules iblock

# Query the Bitrix-aware dependency graph
npx @mb4it/bitrix-mcp graph-neighbors event main:OnBeforeProlog --direction both
npx @mb4it/bitrix-mcp impact-radius local/php_interface/init.php --depth 2

# Show index counters, resolved runtime paths, or environment diagnostics
npx @mb4it/bitrix-mcp status
npx @mb4it/bitrix-mcp config
npx @mb4it/bitrix-mcp doctor
```

Generated indexes are written to `.bitrix-mcp/` by default. Indexing always applies built-in ignores for heavy/generated directories such as `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `upload/`, `cache/`, and `generated/`; it also reads project `.gitignore` rules when present.

To exclude additional project-specific files from LiveAPI and template indexes, add a `.bitrixmcpignore` file to the project root. It uses the same pattern syntax as `.gitignore` and is applied together with the built-in rules and `.gitignore`:

```gitignore
# Generated local scripts
local/scripts/generated/**

# Private custom code that should not be searchable
private/*.php
assets/ignored.js
```

## Bitrix dependency graph and impact radius

Bitrix MCP builds a queryable graph from indexed `bitrix_relations` rather than a generic AST dependency graph. Each edge is a Bitrix relation in the form `source_type:source_name --relation_type--> target_type:target_name`, for example:

- `event:main:OnBeforeProlog --handles_event--> method:Vendor\Module\Handler::onBeforeProlog`
- `file:local/php_interface/init.php --registers_event_handler--> event:main:OnBeforeProlog`
- `component:bitrix:catalog.section --uses_iblock--> iblock:CATALOG_IBLOCK_ID`
- `orm_entity:Vendor\Module\ProductTable --references_orm_entity--> orm_entity:Bitrix\Main\UserTable`

This graph differs from a code-review AST graph because it follows Bitrix concepts that are often dynamic or configured through framework APIs: events and event handlers, module includes, agents, mail events, ORM entity references, components/templates, iblock and highloadblock usage, options, assets, and PHP inheritance relations.

MCP tools:

- `bitrix_graph_neighbors` returns direct or bounded-depth neighbors for a node. Parameters include `nodeType`, `nodeName`, `direction` (`out`, `in`, `both`), `relationType`, `depth`, `limit`, and `format`.
- `bitrix_graph_traverse` performs safe BFS traversal with cycle protection. Parameters include `startType`, `startName`, `direction`, `maxDepth`, `relationTypes`, `limit`, and `format`.
- `bitrix_impact_radius` starts from provided files or `git diff --name-only <base>` (default `HEAD~1`) and groups impacted events, handlers, components, templates, ORM entities, agents, mail events, iblocks, hlblocks, modules, options, classes, and methods. It can include relation-weighted risk reasons for high-impact relations such as `handles_event`, `registers_event_handler`, `registers_agent`, `sends_mail_event`, `references_orm_entity`, `includes_component`, `uses_template`, `extends`, and `implements`.

Examples:

```text
bitrix_graph_neighbors({
  "nodeType": "event",
  "nodeName": "main:OnBeforeProlog",
  "direction": "both"
})

bitrix_graph_traverse({
  "startType": "component",
  "startName": "bitrix:catalog.section",
  "maxDepth": 2,
  "relationTypes": ["uses_iblock", "uses_template"]
})

bitrix_impact_radius({
  "files": ["local/php_interface/init.php"],
  "maxDepth": 2,
  "includeRisk": true
})
```

Optional CLI equivalents are available for quick inspection:

```bash
npx @mb4it/bitrix-mcp graph-neighbors event main:OnBeforeProlog --direction both
npx @mb4it/bitrix-mcp impact-radius local/php_interface/init.php --depth 2
```

## Configuration

Override paths and optional features with environment variables:

- `BITRIX_MCP_DATA_DIR` — index storage directory.
- `BITRIX_MCP_WORKSPACE` — project root used by the MCP server.
- `BITRIX_MCP_DOCS_PATHS` — documentation directories separated by the platform path delimiter (`:` on Unix, `;` on Windows).
- `BITRIX_MCP_DOCS_DIR` — legacy single documentation directory exposed as MCP resources.
- `BITRIX_ROOT` — default Bitrix project root for `index-bitrix`, `index-code`, and `index-all`.
- `BITRIX_MCP_EMBEDDINGS_URL` — Python embeddings service URL, default `http://127.0.0.1:8765`.
- `BITRIX_MCP_SEMANTIC_ENABLED` — enables the optional `bitrix_semantic_docs_search` MCP tool when set to `1`, `true`, `yes`, or `on`; disabled by default.
- `BITRIX_MCP_OFFICIAL_DOCS_ENABLED` — automatically registers, clones or pulls, and indexes the official Bitrix Framework documentation repository during `index-docs`, `index-all`, and `bitrix_index_docs`; enabled by default, set to `0` to use only explicitly registered/local docs.

## Documentation search modes

Bitrix MCP supports two documentation search modes:

1. **Local SQLite FTS (default)** — run `bitrix-mcp index-docs`, `bitrix-mcp index-all`, or the MCP tool `bitrix_index_docs` to clone/pull the official Bitrix Framework documentation repository, index registered Markdown/text documentation into `.bitrix-mcp/bitrix-mcp.sqlite`, and search it with `bitrix_docs_search`. This mode does not need Python or the embeddings service; it needs network access only when cloning or pulling Git documentation sources.
2. **Semantic embeddings (optional)** — first run `bitrix-mcp index-docs` so SQLite contains the canonical documentation chunks, start the Python FastAPI service from `embeddings/`, run `bitrix-mcp index-embeddings` (or `bitrix-mcp index-docs --embeddings`) to POST those same chunks to `/index`, and then set `BITRIX_MCP_SEMANTIC_ENABLED=1` for the MCP server. This registers the additional `bitrix_semantic_docs_search` MCP tool, which calls `BITRIX_MCP_EMBEDDINGS_URL`.

Use local FTS as the baseline documentation search. Enable semantic mode only when you need embedding-based ranking and can run the Python service alongside the MCP server.

## `bitrix-mcp init`

Run `init` from the root of a Bitrix project after installing `@mb4it/bitrix-mcp` globally or making `bitrix-mcp` available on your `PATH`:

```bash
cd /path/to/bitrix/project
bitrix-mcp init
```

The command uses the current working directory as the project root, creates `<projectRoot>/.bitrix-mcp`, sets `BITRIX_MCP_WORKSPACE` to `<projectRoot>`, `BITRIX_MCP_DATA_DIR` to `<projectRoot>/.bitrix-mcp`, and `BITRIX_MCP_DOCS_DIR` to `<projectRoot>/docs`. When `<projectRoot>/bitrix` exists, it also sets `BITRIX_ROOT` to `<projectRoot>`. It then asks which AI agents to configure. You can enter one number or multiple numbers separated by commas; each selected client gets its own MCP configuration created or updated:

- Cursor — `.cursor/mcp.json`.
- Claude Desktop — global `claude_desktop_config.json`.
- Claude Code — project `.mcp.json`.
- PhpStorm / JetBrains — prints a JetBrains AI Assistant MCP JSON snippet to paste into the IDE settings.
- VS Code / GitHub Copilot — `.vscode/mcp.json` using the VS Code `servers` format.
- Windsurf — `~/.codeium/windsurf/mcp_config.json`.
- Cline — `~/.cline/data/settings/cline_mcp_settings.json`.
- Roo Code — `.roo/mcp.json`.
- Continue — `.continue/mcpServers/bitrix-mcp.json`.
- Gemini CLI — `.gemini/settings.json`.
- OpenAI Codex — `~/.codex/config.toml`.
- Kilo Code — `~/.kilocode/cli/global/settings/mcp_settings.json`.
- Other MCP clients — a custom JSON path entered during setup.

For supported JSON clients, `init` reads the existing MCP config and adds or updates only the `bitrix-mcp` entry, preserving other MCP servers and unrelated settings. For every selected agent, `init` also creates a reusable Bitrix MCP skill at `.bitrix-mcp/skills/bitrix-mcp/SKILL.md` and writes an agent-specific rule file so the agent knows when to call the MCP tools:

- Cursor — managed body section in `.cursor/rules/bitrix-mcp.mdc` while preserving existing `.mdc` frontmatter.
- Claude Desktop / Claude Code — managed section in `CLAUDE.md`.
- PhpStorm / JetBrains — managed section in `.junie/guidelines.md`.
- VS Code / GitHub Copilot — managed section in `.github/copilot-instructions.md`.
- Windsurf — managed section in `.windsurf/rules/bitrix-mcp.md`.
- Cline — managed section in `.clinerules/bitrix-mcp.md`.
- Roo Code — managed section in `.roo/rules/bitrix-mcp.md`.
- Continue — managed section in `.continue/rules/bitrix-mcp.md`.
- Gemini CLI — managed section in `GEMINI.md`.
- OpenAI Codex — managed section in `AGENTS.md`.
- Kilo Code — managed section in `.kilocode/rules/bitrix-mcp.md`.
- Other MCP clients — managed section in `.bitrix-mcp/rules/bitrix-mcp.md`.

Generated rule files are safe to update with repeated `bitrix-mcp init` runs: new files receive the full Bitrix MCP template, while existing Markdown and Cursor `.mdc` rule files preserve user content and replace only the `bitrix-mcp:init-guidance` managed section on reruns. The `bitrix-mcp` server runs:

```json
{
  "command": "bitrix-mcp",
  "args": ["serve"]
}
```

### `init` and `configure` flags

- `--agent <id>` — select agents without a prompt. Repeat it or use commas, for example `--agent cursor,codex`. Supported IDs are `cursor`, `claude-desktop`, `claude-code`, `jetbrains`, `vscode`, `windsurf`, `cline`, `roo-code`, `continue`, `gemini-cli`, `codex`, `kilo-code`, and `generic-json`.
- `--all-agents` — configure every built-in agent that does not need an extra custom path prompt.
- `--yes` / `-y` — accept the default non-interactive agent choice (`cursor`).
- `--no-index` — skip project/template/Bitrix code indexing during `init`.
- `--no-docs` — skip documentation indexing during `init`.
- `--no-official-docs` — index only local/registered documentation sources and do not clone or update the official Bitrix Framework docs during `init`.
- `--no-serve` — write configs and run selected indexing steps without starting the MCP stdio server.

Use `bitrix-mcp configure` with the same agent-selection flags when you only want MCP configuration and guidance files. `configure` never indexes code/docs and never starts the server.

After writing the selected configurations, `init` creates `.bitrix-mcp/`, builds missing project/template indexes, builds a Bitrix index when a local `bitrix/` directory is detected, clones or pulls and indexes documentation sources including the official Bitrix Framework docs repository, and starts the MCP server over stdio by default for local interactive runs. In CI (`CI=1` or `GITHUB_ACTIONS=1`) the server start is skipped automatically; pass `--no-serve` explicitly in scripts to make this behavior obvious.

## MCP tools

- **Index/status/config/doctor**: `bitrix_index_project`, `bitrix_index_template`, `bitrix_index_all`, `bitrix_index_docs`, `bitrix_index_status` plus CLI `config` and `doctor`.
- **LiveAPI and symbol search**: `bitrix_liveapi_search`, `bitrix_event_search`, `bitrix_module_usage_search`, `bitrix_inheritance_search`.
- **Source context**: `bitrix_read_file_context`, `bitrix_read_symbol_context`.
- **Agents and mail events**: `bitrix_agent_search`, `bitrix_mail_event_search`.
- **Components**: `bitrix_component_search`, `bitrix_component_context`.
- **ORM**: `bitrix_orm_search`, `bitrix_orm_entity_map`, `bitrix_orm_usage_search`.
- **IBlock / Highloadblock / Options**: `bitrix_iblock_usage_search`, `bitrix_hlblock_usage_search`, `bitrix_option_search`.
- **Relations and graph**: `bitrix_relation_search`, `bitrix_graph_neighbors`, `bitrix_graph_traverse`, `bitrix_impact_radius`.
- **Detect changes**: `bitrix_detect_changes` combines Git-changed indexed records with graph impact, merged risk, and recommendations.
- **Autoload and overview**: `bitrix_autoload_search`, `bitrix_project_overview`.
- **Docs search and API explanation**: `bitrix_docs_search`, `bitrix_docs_for_symbol`, `bitrix_explain_api_usage`, and optional `bitrix_semantic_docs_search` when `BITRIX_MCP_SEMANTIC_ENABLED` is enabled.
- **Benchmarks**: CLI `benchmark` writes `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md`.

### Search result formats

Search tools support shared response-shaping options:

- `kind`: for `bitrix_liveapi_search`, `bitrix_event_search`, and `bitrix_module_usage_search`, restrict results to one index kind (`"project"`, `"template"`, `"bitrix"`, or `"install"`) or an array of kinds.
- `preferLocal`: for `bitrix_liveapi_search` and `bitrix_event_search`, boost `project` and `template` results ahead of equally relevant `bitrix` and `install` results; defaults to `true`.
- `format`: `"compact"` (default) or `"full"`.
- `includeSignature`: include the compact `signature` field for symbol/event results; defaults to `true`.
- `maxSignatureChars`: truncate compact signatures to this many characters; defaults to `160`.
- `maxTextChars`: truncate documentation excerpts to this many characters; defaults to `500`.

Compact mode is optimized for agent context windows. `bitrix_liveapi_search` and `bitrix_event_search` return short rows with `score`, `type`, `kind`, `name`, `module`, workspace-relative `file`, `line`, and a truncated `signature` when available:

```json
{
  "query": "CIBlockElement::GetList",
  "limit": 3
}
```

Example compact response shape:

```json
[
  {
    "score": 1,
    "type": "method",
    "kind": "bitrix",
    "name": "CIBlockElement::GetList",
    "module": "iblock",
    "file": "bitrix/modules/iblock/classes/general/iblockelement.php",
    "line": 785,
    "signature": "CIBlockElement::GetList($arOrder = [], $arFilter = [], $arGroupBy = false, $arNavStartParams = false, $arSelectFields = [])"
  }
]
```

After a symbol search returns a `file` and `line`, call `bitrix_read_file_context` to inspect the surrounding implementation without exposing paths outside the configured workspace/data allowlist:

```json
{
  "file": "bitrix/modules/iblock/classes/general/iblockelement.php",
  "line": 785,
  "before": 8,
  "after": 24,
  "maxChars": 12000
}
```

Example response shape:

```json
{
  "metadata": {
    "absolutePath": "/path/to/project/bitrix/modules/iblock/classes/general/iblockelement.php",
    "relativePath": "bitrix/modules/iblock/classes/general/iblockelement.php",
    "language": "php",
    "startLine": 777,
    "endLine": 809,
    "totalLines": 4230,
    "truncated": false
  },
  "numberedLines": "777: ...\n785: public static function GetList(...)\n809: ..."
}
```


Module usage compact mode returns the module name, API call, index kind, relative file, line, and exact call signature:

```json
{
  "module": "iblock",
  "limit": 5
}
```

Example compact module usage response shape:

```json
[
  {
    "module": "iblock",
    "call": "Loader::includeModule",
    "kind": "project",
    "file": "local/php_interface/init.php",
    "line": 42,
    "signature": "Loader::includeModule('iblock')"
  }
]
```

Documentation search compact mode returns an `excerpt` instead of the full indexed chunk. Matching query terms are highlighted when possible; otherwise the chunk is truncated:

```json
{
  "query": "sale order event",
  "limit": 2,
  "maxTextChars": 300
}
```

Example compact documentation response shape:

```json
[
  {
    "score": 0.9,
    "type": "doc",
    "title": "Sale events",
    "uri": "bitrix-docs://framework/sale/events.md",
    "path": "sale/events.md",
    "chunkIndex": 0,
    "excerpt": "...register handlers for **sale** **order** **event** callbacks..."
  }
]
```

Use full mode when you need the raw indexed payload, including full symbol metadata or full documentation chunk text:

```json
{
  "query": "CIBlockElement::GetList",
  "limit": 1,
  "format": "full"
}
```

To reduce symbol/event output further while staying in compact mode, disable signatures explicitly:

```json
{
  "query": "OnSaleOrderSaved",
  "format": "compact",
  "includeSignature": false
}
```


### Search by index kind

Use `kind` when you want to separate local project code from Bitrix core, templates, or module install assets. If `kind` is omitted, project and template matches are boosted ahead of equally relevant core/install matches by default.

Search only project event handlers:

```json
{
  "query": "OnBeforeProlog",
  "module": "main",
  "kind": "project",
  "limit": 10
}
```

Search only Bitrix core API symbols:

```json
{
  "query": "CIBlockElement::GetList",
  "type": "method",
  "kind": "bitrix",
  "limit": 5
}
```

Search only module install assets, for example frontend exports or admin widgets indexed from `install/js`:

```json
{
  "query": "VendorWidget",
  "kind": "install",
  "limit": 10
}
```

You can also pass an array to search several source kinds while still excluding the rest, for example `{ "kind": ["project", "template"] }`.

## MCP resources

- `bitrix-docs://index` — JSON list of local documentation resources.
- `bitrix-docs://framework/getting-started.md` — bundled starter reference.

By default documentation indexing uses `https://github.com/bitrix-tools/framework-docs.git` plus any local `docs/` directory and registered docs sources. Place additional `.md` or `.txt` files under `docs/` to expose them through the documentation index, or set `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0` to skip the official repository.

## Example prompts

Use prompts like these in your MCP-capable AI client after Bitrix MCP is configured:

```text
Use Bitrix MCP to show index status and tell me whether project, template, Bitrix, and documentation indexes are ready.
```

```text
Use bitrix_liveapi_search to find examples of CIBlockElement::GetList usage and explain the parameters relevant to this project.
```

```text
Search Bitrix MCP docs for sale order event handlers, then find matching handlers in this project.
```

```text
Use Bitrix MCP to inspect local/templates/main and explain which components and template assets are used on the catalog page.
```

```text
Before changing code, use Bitrix MCP to find existing project helpers for user fields and suggest the safest implementation plan.
```

```text
Refresh Bitrix MCP indexes, then check whether any custom module install assets define admin JavaScript widgets.
```

## Python embeddings service

```bash
cd embeddings
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows PowerShell
# .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn service:app --host 127.0.0.1 --port 8765
```

Recommended semantic indexing sequence:

```bash
# 1. Populate SQLite with documentation chunks.
bitrix-mcp index-docs

# 2. Start the embeddings service in another shell.
cd embeddings
uvicorn service:app --host 127.0.0.1 --port 8765

# 3. Send the SQLite chunks to the embeddings service.
bitrix-mcp index-embeddings
# Or combine steps 1 and 3 when the service is already running:
bitrix-mcp index-docs --embeddings

# 4. Enable the semantic MCP tool before starting the MCP server.
export BITRIX_MCP_SEMANTIC_ENABLED=1
bitrix-mcp serve
```

`bitrix-mcp doctor` checks the embeddings service health only when semantic mode is enabled with `BITRIX_MCP_SEMANTIC_ENABLED=1`; otherwise it reports that semantic search is disabled and skips the embeddings request. When enabled, it also verifies that the service document count matches the current SQLite documentation chunk count. If the counts differ, rerun `bitrix-mcp index-embeddings` after `bitrix-mcp index-docs`.

### Troubleshooting runtime configuration

Use `bitrix-mcp config` when an MCP client starts the server from a different directory than expected, writes indexes to an unexpected location, or cannot find documentation/Bitrix sources. The command prints the exact values resolved by `resolveRuntimePaths`: `workspaceRoot`, `dataDir`, `sqlitePath`, `docsPaths`, `bitrixRoot`, `embeddingsUrl`, `semanticEnabled`, and `officialDocsEnabled`. It also reports whether common MCP client config files are present for Cursor, Claude Desktop, Claude Code, VS Code/GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Gemini CLI, OpenAI Codex, and Kilo Code.

```bash
bitrix-mcp config
bitrix-mcp config --json
```

For a combined health check and configuration dump, run `bitrix-mcp doctor --verbose`. Scripts and CI jobs can use JSON output from `bitrix-mcp doctor --json`; the process still exits with a non-zero status when doctor detects an error.

```bash
bitrix-mcp doctor --verbose
bitrix-mcp doctor --json
```

You can also POST chunks to `/index` manually:

```json
{
  "documents": [
    {
      "id": "framework/events",
      "text": "Bitrix events are registered with AddEventHandler...",
      "metadata": { "uri": "bitrix-docs://framework/events.md" }
    }
  ]
}
```

Search through `/search` or, when `BITRIX_MCP_SEMANTIC_ENABLED=1`, the MCP tool `bitrix_semantic_docs_search`. The service also exposes `/health`, `/stats`, and `/reload`; `/search` keeps the JSON index and embedding matrix in memory after load/reload instead of rebuilding them for every request.

## Agent configuration example

For a project at `/var/www/site`, the final per-project MCP config written by `bitrix-mcp init` looks like this. If `/var/www/site/bitrix` exists, `BITRIX_ROOT` is included; otherwise that line is omitted. Existing sibling servers such as `another-server` are preserved.

```json
{
  "mcpServers": {
    "another-server": {
      "command": "another-tool",
      "args": ["serve"]
    },
    "bitrix-mcp": {
      "command": "bitrix-mcp",
      "args": ["serve"],
      "env": {
        "BITRIX_MCP_WORKSPACE": "/var/www/site",
        "BITRIX_MCP_DATA_DIR": "/var/www/site/.bitrix-mcp",
        "BITRIX_MCP_DOCS_PATHS": "/var/www/site/docs:/var/www/site/vendor-docs",
        "BITRIX_MCP_DOCS_DIR": "/var/www/site/docs",
        "BITRIX_ROOT": "/var/www/site",
        "BITRIX_MCP_EMBEDDINGS_URL": "http://127.0.0.1:8765",
        "BITRIX_MCP_SEMANTIC_ENABLED": "0"
      }
    }
  }
}
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Phase 17 benchmark reporting

Run benchmark reporting from this repository or from an installed package:

```bash
npm run benchmark
# or, after build/install
bitrix-mcp benchmark
```

Reports are written to `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md`. The benchmark measures incremental `index-all`, `index-project`, `index-template`, optional `index-bitrix`, docs search, LiveAPI search, event search, relation search, graph traversal, impact-radius, detect-changes, SQLite DB size, indexed files, symbols, events, relations, and docs chunks. It skips missing Bitrix roots, missing docs, and unavailable optional indexes with warnings. It does not force a full reindex unless `--force` is passed.

## Documentation map

- [MCP tools](./docs/tools.md) — implemented tools only, with parameters, examples, prompts, usage guidance, and limitations.
- [Indexing](./docs/indexing.md) — indexing scopes and benchmark reporting.
- [Bitrix events](./docs/bitrix-events.md) — event-search workflow.
- [ORM](./docs/orm.md) — D7 entity and usage workflow.
- [Components](./docs/components.md) — component/template workflow.
- [Graph](./docs/graph.md) — `bitrix_relations`, neighbors, traversal, and impact radius.
- [Detect changes](./docs/detect-changes.md) — review workflow.
- [Security](./docs/security.md) — local data, path restrictions, and network notes.
- [Examples](./docs/examples.md) — copy-ready prompts.

Recommended AI workflow:

1. General project work: `bitrix_index_status` → `bitrix_project_overview` → `bitrix_liveapi_search` / `bitrix_docs_search` as needed → `bitrix_read_file_context` or `bitrix_read_symbol_context`.
2. Review work: `bitrix_detect_changes` → `bitrix_impact_radius` → `bitrix_graph_neighbors` or `bitrix_graph_traverse` → `bitrix_relation_search` → context tools.
3. Bitrix events: `bitrix_event_search` → `bitrix_relation_search` → `bitrix_graph_neighbors` → `bitrix_read_file_context`.
4. ORM: `bitrix_orm_search` → `bitrix_orm_entity_map` → `bitrix_orm_usage_search` → `bitrix_graph_neighbors`.
5. Components: `bitrix_component_search` → `bitrix_component_context` → `bitrix_impact_radius` when changing component files.
