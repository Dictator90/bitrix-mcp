# Bitrix Framework MCP reference

This resource is a seed documentation page shipped with the server. By default, `bitrix-mcp index-docs`, `bitrix-mcp index-all`, and the `bitrix_index_docs` MCP tool register and clone or pull the official Bitrix Framework documentation repository before indexing Markdown/text documentation into local SQLite FTS. Put extra exported Bitrix Framework Markdown or text files into the `docs/` directory when you need project-local references too.

## LiveAPI workflow

1. Install or mount a Bitrix project on the same machine as the MCP server.
2. Run `bitrix-mcp index-bitrix /path/to/site` to parse `/bitrix/modules/**/*.php` and `/local/modules/**/*.php`.
3. Run `bitrix-mcp index-project /path/to/project` to index the current project.
4. Run `bitrix-mcp index-template /path/to/project` to refresh template/component/script/style indexes.
5. Run `bitrix-mcp index-docs` or `bitrix-mcp index-all` to clone/pull and index the official Bitrix Framework documentation repository for `bitrix_docs_search`.

The MCP tool `bitrix_liveapi_search` reads these generated indexes and returns matching symbols with file paths, line numbers, modules, signatures, and symbol types.
