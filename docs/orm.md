# ORM

Workflow: `bitrix_orm_search` → `bitrix_orm_entity_map` → `bitrix_orm_usage_search` → `bitrix_graph_neighbors`.

Example prompt: "Use Bitrix MCP to find all ORM entities and their table names." Entity maps are statically extracted from indexed D7 DataManager classes, so dynamic map construction can be incomplete and should be verified in source context.
