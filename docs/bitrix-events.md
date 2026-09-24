# Bitrix events

Workflow: `bitrix_event_search` → `bitrix_entity_search` (`entity: "relation"`) → `bitrix_graph_neighbors` → `bitrix_read_file_context`. The `trace-event` MCP prompt (arguments `module`, `event`, both auto-completed from the index) runs this flow.

Example prompt: "Use Bitrix MCP to find all handlers for sale module events." Search results include module, event name, handler class/method/function, file, line, and signature when available. Use relation and graph tools to see connected handlers and impact.
