# Bitrix MCP

Local, token-free MCP server for AI agents that need reference access to **Bitrix Framework** projects without installing a Bitrix module or modifying the 1C-Bitrix runtime.

## Capabilities

- **LiveAPI**: indexes PHP sources from an installed Bitrix instance and searches functions, classes, methods, events, components, and constants.
- **Project indexing**: indexes the current project through a terminal command or MCP tool.
- **Template indexing**: separately indexes templates, components, scripts, styles, and layout assets.
- **MCP resources**: exposes local Bitrix Framework documentation files as MCP resources.
- **Semantic documentation search**: delegates embeddings to a Python `sentence-transformers` FastAPI service.
- **Public local access**: no token or Bitrix authentication is required; access is controlled by where you run the process.

## Requirements

- Node.js 20+
- npm 10+
- Python 3.11+ for semantic search
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

# Index the current project
npx bitrix-mcp index-project /path/to/project

# Index templates/components/scripts/styles separately
npx bitrix-mcp index-template /path/to/project

# Index installed Bitrix Framework PHP sources for LiveAPI
npx bitrix-mcp index-bitrix /path/to/bitrix/site
```

Generated indexes are written to `.bitrix-mcp/` by default. Override paths with environment variables:

- `BITRIX_MCP_DATA_DIR` — index storage directory.
- `BITRIX_MCP_WORKSPACE` — project root used by the MCP server.
- `BITRIX_MCP_DOCS_DIR` — documentation directory exposed as MCP resources.
- `BITRIX_ROOT` — default Bitrix installation root for `index-bitrix`.
- `BITRIX_MCP_EMBEDDINGS_URL` — Python embeddings service URL, default `http://127.0.0.1:8765`.

## `bitrix-mcp init`

Run `init` from the root of a Bitrix project after installing `bitrix-mcp` globally or making it available on your `PATH`:

```bash
cd /path/to/bitrix/project
bitrix-mcp init
```

The command uses the current working directory as the project root, sets `BITRIX_MCP_DATA_DIR` to `<projectRoot>/.bitrix-mcp`, sets `BITRIX_MCP_WORKSPACE` to the same project, and automatically treats the current project as `BITRIX_ROOT` when `<projectRoot>/bitrix` exists. It then asks which AI agents to configure. You can enter one number or multiple numbers separated by commas; each selected client gets its own MCP configuration created or updated:

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

For supported JSON clients, `init` adds a `bitrix-mcp` server that runs:

```json
{
  "command": "bitrix-mcp",
  "args": ["serve"]
}
```

After writing the selected configurations, `init` creates `.bitrix-mcp/`, builds missing project/template indexes, builds a Bitrix index when a local `bitrix/` directory is detected, and starts the MCP server over stdio.

## MCP tools

- `bitrix_liveapi_search` — search indexed PHP symbols.
- `bitrix_index_project` — index the current project from an agent.
- `bitrix_index_template` — index templates from an agent.
- `bitrix_semantic_docs_search` — semantic documentation search through embeddings.

## MCP resources

- `bitrix-docs://index` — JSON list of local documentation resources.
- `bitrix-docs://framework/getting-started.md` — bundled starter reference.

Place additional `.md` or `.txt` files under `docs/` to expose them through the documentation index.

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

Search through `/search` or the MCP tool `bitrix_semantic_docs_search`.

## Agent configuration example

```json
{
  "mcpServers": {
    "bitrix-mcp": {
      "command": "npx",
      "args": ["bitrix-mcp", "serve"],
      "env": {
        "BITRIX_MCP_DATA_DIR": "/path/to/project/.bitrix-mcp",
        "BITRIX_MCP_DOCS_DIR": "/path/to/project/docs",
        "BITRIX_MCP_EMBEDDINGS_URL": "http://127.0.0.1:8765"
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
