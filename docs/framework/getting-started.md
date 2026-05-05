# Bitrix Framework MCP reference

This resource is a seed documentation page shipped with the server. Put exported Bitrix Framework Markdown or text files into the `docs/` directory and run the embeddings service indexing endpoint to make them searchable semantically.

## LiveAPI workflow

1. Install or mount a Bitrix project on the same machine as the MCP server.
2. Run `bitrix-mcp index-bitrix /path/to/site` to parse `/bitrix/modules/**/*.php` and `/local/modules/**/*.php`.
3. Run `bitrix-mcp index-project /path/to/project` to index the current project.
4. Run `bitrix-mcp index-template /path/to/project` to refresh template/component/script/style indexes.

The MCP tool `bitrix_liveapi_search` reads these generated indexes and returns matching symbols with file paths, line numbers, modules, signatures, and symbol types.
