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
- Use Bitrix MCP to show index status and tell me whether project, template, Bitrix, and documentation indexes are ready.
- Use bitrix_liveapi_search to find examples of CIBlockElement::GetList usage and explain the parameters relevant to this project.
- Search Bitrix MCP docs for sale order event handlers, then find matching handlers in this project.
- Use Bitrix MCP to inspect local/templates/main and explain which components and template assets are used on the catalog page.
- Before changing code, use Bitrix MCP to find existing project helpers for user fields and suggest the safest implementation plan.
- Refresh Bitrix MCP indexes, then check whether any custom module install assets define admin JavaScript widgets.
