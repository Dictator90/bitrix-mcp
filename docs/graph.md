# Dependency graph

`bitrix_relations` is the canonical graph edge table. Use `bitrix_relation_search` for edge lookup, `bitrix_graph_neighbors` for direct dependencies, `bitrix_graph_traverse` for bounded cycle-safe BFS, and `bitrix_impact_radius` for changed-file impact.

Example prompt: "Use Bitrix MCP to traverse graph dependencies for bitrix:catalog.section." Traversals are intentionally bounded by depth and result limits.
