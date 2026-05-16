# Changelog

## Unreleased

- Added `bitrix_read_symbol_context` MCP tool for reading source excerpts by indexed symbol name with ambiguity reporting, body expansion via `lineEnd`, path allowlist checks, and truncation controls.
- Added `lineEnd` metadata for AST-indexed PHP class, interface, trait, function, and method symbols while keeping existing symbol records compatible.
- Added tests for symbol context reads, ambiguity handling, body inclusion, path safety, and truncation.
- Added Bitrix module option usage indexing for `Option::get/set`, fully qualified `Bitrix\Main\Config\Option::get/set`, and legacy `COption` option APIs.
- Added SQLite storage, relation writes, search formatting, and the `bitrix_option_search` MCP tool for option reads/writes.
- Added coverage for option parsing, dynamic option-name safety, relation creation, and MCP tool search behavior.
