# Bitrix events

Workflow: `bitrix_event_search` → `bitrix_relation_search` → `bitrix_graph_neighbors` → `bitrix_read_file_context`.

Example prompt: "Use Bitrix MCP to find all handlers for sale module events." Search results include module, event name, handler class/method/function, file, line, and signature when available. Use relation and graph tools to see connected handlers and impact.
