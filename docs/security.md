# Security and local data

Bitrix MCP is local and token-free. It indexes files from configured local roots into `.bitrix-mcp/bitrix-mcp.sqlite`; keep that directory private if source paths or snippets are sensitive. File-context reads are restricted to the workspace and data directory. Project/template indexing through MCP rejects paths outside the workspace unless `BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1` is explicitly set. Built-in indexing ignores skip heavy or generated trees including `node_modules/`, `vendor/`, `upload/`, `cache/`, and `generated/`.

Documentation Git sources may require network during `index-docs`/`index-all` when official docs are enabled. Benchmark reporting writes JSON/Markdown reports but never deletes user data.
