# Detect changes and review workflow

Workflow: `bitrix_detect_changes` (includes graph impact by default) → `bitrix_graph_neighbors` or `bitrix_graph_traverse` → `bitrix_relation_search` → `bitrix_read_file_context` or `bitrix_read_symbol_context`.

Example prompt: "Use Bitrix MCP to analyze changes since origin/main." The tool uses Git diff names and indexed metadata, plus `bitrix_relations` graph impact; pass a valid `base` ref and rerun indexing if the SQLite counters are stale. Unsafe base refs are rejected before Git is called. If Git is unavailable or the base cannot be read, the response is deterministic and compact: no changed files are returned and a `warnings` array explains the limitation.


`bitrix_detect_changes` includes changed components, ORM entities/usages, IBlock usages, Highloadblock usages, options, related relations, merged risk, and deterministic recommendations. Use `includeImpact: false` or CLI `--no-impact` only when graph traversal is not needed.
