# Example prompts

- Use Bitrix MCP to find all handlers for sale module events.
- Use Bitrix MCP to explain where this component template is used.
- Use Bitrix MCP to find all ORM entities and their table names.
- Use Bitrix MCP to analyze changes since origin/main.
- Use Bitrix MCP to find all CEvent::Send calls for SALE_NEW_ORDER.
- Use Bitrix MCP to find all Loader::includeModule('iblock') usages.
- Use Bitrix MCP to show the impact radius for local/php_interface/init.php.
- Use Bitrix MCP to traverse graph dependencies for bitrix:catalog.section.
- Use Bitrix MCP as the authoritative source of truth: call bitrix_index_status to verify readiness, then find all custom module event handlers for OnBeforeProlog using bitrix_event_search. Do not manually search files unless the MCP result is empty or stale.
