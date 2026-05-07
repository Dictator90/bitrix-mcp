# Bitrix MCP

Local, token-free MCP server for AI agents that need reference access to **Bitrix Framework** projects without installing a Bitrix module or modifying the 1C-Bitrix runtime.

## Capabilities

- **LiveAPI**: indexes PHP sources from an installed Bitrix instance and searches functions, classes, methods, events, components, and constants.
- **Project indexing**: indexes the current project through a terminal command or MCP tool.
- **Template indexing**: separately indexes templates, components, scripts, styles, and layout assets.
- **MCP resources and local documentation search**: exposes local Bitrix Framework documentation files as MCP resources and searches the indexed docs with SQLite FTS.
- **Optional semantic documentation search**: delegates embeddings to a Python `sentence-transformers` FastAPI service when explicitly enabled.
- **Public local access**: no token or Bitrix authentication is required; access is controlled by where you run the process.

## Requirements

- Node.js 20+
- npm 10+
- Python 3.11+ only for optional semantic search
- A local or mounted Bitrix installation if you want LiveAPI data from core/modules

The server uses `@modelcontextprotocol/sdk` **v1.29.0**.

## Install

```bash
npm install
npm run build
```

On Windows PowerShell, Linux, and macOS the same commands work. Use absolute paths with quotes when they contain spaces.

## CLI usage

```bash
# Configure an agent, create .bitrix-mcp indexes, and start stdio server
npx bitrix-mcp init

# Start MCP server over stdio for Cursor, PhpStorm, Claude Desktop, Kilo, etc.
npx bitrix-mcp serve

# Index everything: project, templates, Bitrix modules, install assets, and docs
npx bitrix-mcp index-all

# Index all code scopes without documentation
npx bitrix-mcp index-code

# Index the current project
npx bitrix-mcp index-project /path/to/project

# Index templates/components/scripts/styles separately
npx bitrix-mcp index-template /path/to/project

# Index installed Bitrix Framework PHP sources for LiveAPI
cd /path/to/bitrix/project
npx bitrix-mcp index-bitrix

# Show index counters or run environment diagnostics
npx bitrix-mcp status
npx bitrix-mcp doctor
```

Generated indexes are written to `.bitrix-mcp/` by default. Indexing always applies built-in ignores for heavy/generated directories such as `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `upload/`, and `cache/`; it also reads project `.gitignore` rules when present.

To exclude additional project-specific files from LiveAPI and template indexes, add a `.bitrixmcpignore` file to the project root. It uses the same pattern syntax as `.gitignore` and is applied together with the built-in rules and `.gitignore`:

```gitignore
# Generated local scripts
local/scripts/generated/**

# Private custom code that should not be searchable
private/*.php
assets/ignored.js
```

Override paths with environment variables:

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
2. **Semantic embeddings (optional)** — start the Python FastAPI service from `embeddings/`, index documents into that service, and set `BITRIX_MCP_SEMANTIC_ENABLED=1` for the MCP server. This registers the additional `bitrix_semantic_docs_search` MCP tool, which calls `BITRIX_MCP_EMBEDDINGS_URL`.

Use local FTS as the baseline documentation search. Enable semantic mode only when you need embedding-based ranking and can run the Python service alongside the MCP server.

## `bitrix-mcp init`

Run `init` from the root of a Bitrix project after installing `bitrix-mcp` globally or making it available on your `PATH`:

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

- Cursor — `.cursor/rules/bitrix-mcp.mdc`.
- Claude Desktop / Claude Code — managed section in `CLAUDE.md`.
- PhpStorm / JetBrains — managed section in `.junie/guidelines.md`.
- VS Code / GitHub Copilot — managed section in `.github/copilot-instructions.md`.
- Windsurf — `.windsurf/rules/bitrix-mcp.md`.
- Cline — `.clinerules/bitrix-mcp.md`.
- Roo Code — `.roo/rules/bitrix-mcp.md`.
- Continue — `.continue/rules/bitrix-mcp.md`.
- Gemini CLI — managed section in `GEMINI.md`.
- OpenAI Codex — managed section in `AGENTS.md`.
- Kilo Code — `.kilocode/rules/bitrix-mcp.md`.
- Other MCP clients — `.bitrix-mcp/rules/bitrix-mcp.md`.

Generated append-style files preserve existing content and replace only the `bitrix-mcp:init-guidance` managed section on reruns. The `bitrix-mcp` server runs:

```json
{
  "command": "bitrix-mcp",
  "args": ["serve"]
}
```

After writing the selected configurations, `init` creates `.bitrix-mcp/`, builds missing project/template indexes, builds a Bitrix index when a local `bitrix/` directory is detected, clones or pulls and indexes documentation sources including the official Bitrix Framework docs repository, and starts the MCP server over stdio.

## MCP tools

- `bitrix_liveapi_search` — search indexed PHP symbols.
- `bitrix_event_search` — search indexed Bitrix event handlers by module, event name, class/method, or function.
- `bitrix_index_project` — index the current project from an agent.
- `bitrix_index_all` — index project files, templates, Bitrix modules, install assets, and documentation sources, including the official Bitrix Framework docs repository when official docs are enabled.
- `bitrix_index_status` — report the SQLite DB path plus files, symbols, events, documents, and last index timestamp.
- `bitrix_index_template` — index standard template locations, or pass `templatePath` relative to the project root (for example `local/templates/site`) to index a specific template directory. The temporary `root` argument is deprecated; use `templatePath` instead.
- `bitrix_index_docs` — clone/pull and index documentation sources into SQLite, including the official Bitrix Framework docs repository when official docs are enabled.
- `bitrix_docs_search` — default local SQLite FTS documentation search.
- `bitrix_semantic_docs_search` — optional semantic documentation search through embeddings; available only when `BITRIX_MCP_SEMANTIC_ENABLED` is enabled.

## MCP resources

- `bitrix-docs://index` — JSON list of local documentation resources.
- `bitrix-docs://framework/getting-started.md` — bundled starter reference.

By default documentation indexing uses `https://github.com/bitrix-tools/framework-docs.git` plus any local `docs/` directory and registered docs sources. Place additional `.md` or `.txt` files under `docs/` to expose them through the documentation index, or set `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0` to skip the official repository.

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

Index documents by POSTing chunks to `/index`:

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
