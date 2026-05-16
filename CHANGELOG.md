# Changelog

## Unreleased

- Added a Bitrix-aware dependency graph over `bitrix_relations` with bounded neighbor lookup, BFS traversal, impact-radius analysis, relation weighting, MCP tools, optional CLI commands, docs, and tests.

- Added PHP AST enrichment for namespaces, imports, fully qualified names, inheritance, trait usage, modifiers, return types, parameters, defaults, and declaration end lines.
- Added inheritance relation writes for class `extends`, `implements`, and trait-use metadata plus `bitrix_inheritance_search` for querying those relationships.
- Extended symbol SQLite persistence with optional enriched PHP metadata while preserving backward-compatible symbol fields.
- Added parser, relation, and MCP coverage for enriched PHP symbols and inheritance searches.

- Added `bitrix_read_symbol_context` MCP tool for reading source excerpts by indexed symbol name with ambiguity reporting, body expansion via `lineEnd`, path allowlist checks, and truncation controls.
- Added `lineEnd` metadata for AST-indexed PHP class, interface, trait, function, and method symbols while keeping existing symbol records compatible.
- Added tests for symbol context reads, ambiguity handling, body inclusion, path safety, and truncation.
- Added Bitrix module option usage indexing for `Option::get/set`, fully qualified `Bitrix\Main\Config\Option::get/set`, and legacy `COption` option APIs.
- Added SQLite storage, relation writes, search formatting, and the `bitrix_option_search` MCP tool for option reads/writes.
- Added coverage for option parsing, dynamic option-name safety, relation creation, and MCP tool search behavior.
