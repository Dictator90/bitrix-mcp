# Configuration

## Environment variables

| Variable | Purpose |
| --- | --- |
| `BITRIX_MCP_DATA_DIR` | Index storage directory (default `<project>/.bitrix-mcp`). |
| `BITRIX_MCP_WORKSPACE` | Project root used by the MCP server. |
| `BITRIX_MCP_DOCS_PATHS` | Documentation directories, separated by the platform path delimiter (`:` Unix, `;` Windows). |
| `BITRIX_MCP_DOCS_DIR` | Legacy single documentation directory exposed as MCP resources. |
| `BITRIX_ROOT` | Default Bitrix project root for `index-bitrix`, `index-code`, `index-all`. |
| `BITRIX_MCP_OFFICIAL_DOCS_ENABLED` | Auto-register/clone/index the official Bitrix docs during docs indexing. On by default; set `0` to use only local/registered docs. |
| `BITRIX_MCP_EMBEDDINGS_URL` | Python embeddings service URL (default `http://127.0.0.1:8765`). |
| `BITRIX_MCP_SEMANTIC_ENABLED` | Enable the optional `bitrix_semantic_docs_search` tool (`1`/`true`/`yes`/`on`). Off by default. |
| `BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE` | Allow MCP indexing of paths outside the workspace when set to `1`. |

## `bitrix-mcp init`

Run `init` from the root of a Bitrix project. It uses the current directory as the project root, creates `<root>/.bitrix-mcp`, and sets `BITRIX_MCP_WORKSPACE`, `BITRIX_MCP_DATA_DIR`, and `BITRIX_MCP_DOCS_DIR`. When `<root>/bitrix` exists, it also sets `BITRIX_ROOT`.

It then asks which AI agents to configure (enter one or several numbers, comma-separated). For each selected client it:

1. Creates/updates that client's MCP config, preserving other servers and unrelated settings.
2. Writes an agent-specific rule file plus a reusable skill at `.bitrix-mcp/skills/bitrix-mcp/SKILL.md`.
3. Builds missing indexes (project, templates, Bitrix core when `bitrix/` exists, and docs).

`init` does **not** start the stdio server by default — the MCP config it writes launches `bitrix-mcp serve` from your client. Pass `--serve` to start it now, or run `bitrix-mcp serve` yourself.

Rule files are safe to re-run: new files get the full template; existing files keep your content and only the `bitrix-mcp:init-guidance` managed section is replaced.

### Supported clients

| Agent ID | MCP config | Rule file |
| --- | --- | --- |
| `cursor` | `.cursor/mcp.json` | `.cursor/rules/bitrix-mcp.mdc` |
| `claude-code` | project `.mcp.json` | `CLAUDE.md` (+ skill in `.claude/skills/bitrix-mcp/`) |
| `jetbrains` | printed JSON snippet to paste | `.junie/guidelines.md` |
| `vscode` | `.vscode/mcp.json` (`servers` format) | `.github/copilot-instructions.md` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/rules/bitrix-mcp.md` |
| `cline` | `~/.cline/data/settings/cline_mcp_settings.json` | `.clinerules/bitrix-mcp.md` |
| `roo-code` | `.roo/mcp.json` | `.roo/rules/bitrix-mcp.md` |
| `continue` | `.continue/mcpServers/bitrix-mcp.json` | `.continue/rules/bitrix-mcp.md` |
| `gemini-cli` | `.gemini/settings.json` | `GEMINI.md` |
| `codex` | `~/.codex/config.toml` | `AGENTS.md` |
| `kilo-code` | `~/.kilocode/cli/global/settings/mcp_settings.json` | `.kilocode/rules/bitrix-mcp.md` |
| `generic-json` | custom JSON path you enter | `.bitrix-mcp/rules/bitrix-mcp.md` |

Claude Desktop reads the project `.mcp.json`, so use `claude-code` for it.

### `init` / `configure` flags

- `--agent <id>` — select agents without a prompt. Repeat or comma-separate, e.g. `--agent cursor,codex`.
- `--all-agents` — configure every built-in agent that needs no extra path prompt.
- `--yes` / `-y` — accept the default non-interactive choice (`cursor`).
- `--no-index` — skip code indexing during `init`.
- `--no-docs` — skip documentation indexing during `init`.
- `--no-official-docs` — index only local/registered docs (don't clone the official repo).
- `--serve` — start the stdio server after init (default: don't).
- `--no-serve` — explicit no-op for the default behavior.

Use `bitrix-mcp configure` with the same agent flags when you only want config + guidance files (never indexes, never serves).

### Generated MCP config

For a project at `/var/www/site`, `init` writes a per-project config like this (`BITRIX_ROOT` is included only when `bitrix/` exists; existing sibling servers are preserved):

```json
{
  "mcpServers": {
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

## Troubleshooting

Use `bitrix-mcp config` when an MCP client starts the server from an unexpected directory, writes indexes to an unexpected location, or can't find docs/Bitrix sources. It prints the resolved `workspaceRoot`, `dataDir`, `sqlitePath`, `docsPaths`, `bitrixRoot`, `embeddingsUrl`, `semanticEnabled`, and `officialDocsEnabled`, plus which client config files are present.

```bash
bitrix-mcp config            # or --json
bitrix-mcp doctor --verbose  # combined health check + config dump
bitrix-mcp doctor --json     # for scripts/CI; non-zero exit on error
```

Common `doctor` warnings and fixes:

| Warning | Meaning | Fix |
| --- | --- | --- |
| `bitrixRoot: Bitrix root was not detected` | No `./bitrix` and `BITRIX_ROOT` unset; LiveAPI core indexing is skipped. | Run from the Bitrix project root, pass a root to `index-bitrix`, or export `BITRIX_ROOT`. |
| `bitrixRoot: ... /bitrix is missing` | `BITRIX_ROOT` points to the wrong directory. | Fix `BITRIX_ROOT`, then rerun `index-bitrix`/`index-code`. |
| `docsSources: No documentation paths ... found` | No local docs path and no registered docs source. | Add files under `docs/`, run `docs-add-path`, or `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=1 bitrix-mcp index-docs`. |
| `docsSources: Missing ... directories` | A configured docs path or Git checkout no longer exists. | Restore it, update `BITRIX_MCP_DOCS_PATHS`, or run `docs-update`. |
| `bitrixmcpignore: ... not present` | Reminder that built-in + `.gitignore` ignores are used. | Optional: create `.bitrixmcpignore` to exclude private/generated files. |
| `phpParse: ... regex fallback` | Some PHP files failed AST parsing and used a regex fallback. | Reindex with `BITRIX_MCP_DEBUG_PARSE=1 bitrix-mcp index-code` to see paths; results are usually still searchable. |
| `embeddingsService: ... unavailable` | Semantic mode is on but the service isn't reachable. | Start the service, check `BITRIX_MCP_EMBEDDINGS_URL`, or unset `BITRIX_MCP_SEMANTIC_ENABLED`. |
| `embeddingsService: ... document count differs` | SQLite docs were reindexed after embeddings were populated. | Run `index-embeddings` after `index-docs` (or `index-docs --embeddings`). |
