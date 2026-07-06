# Indexing

Bitrix MCP stores indexes in `.bitrix-mcp/bitrix-mcp.sqlite`. Use `bitrix-mcp index-all` or MCP `bitrix_index_all` for project, template, Bitrix core/install assets, and docs. Use narrower commands/tools when only one scope changed: `index-project`, `index-template`, `index-bitrix`, `index-install`, `index-docs` or MCP `bitrix_index_project`, `bitrix_index_template`, `bitrix_index_docs`.

For the full command list, Bitrix core module selection, incremental reindex behavior, and progress options, see [cli.md](./cli.md). Reindexing is incremental — a file is re-parsed only when its size or mtime changed.

`npm run benchmark` and `bitrix-mcp benchmark` generate `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md`. By default the benchmark uses incremental indexing and does not force a full reindex; pass `--force` only when you intentionally want cold/full timings. Missing Bitrix roots, docs, or optional indexes are reported as warnings instead of deleting data or failing the whole benchmark.
