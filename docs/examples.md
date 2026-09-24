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

## Tool calls

Prompts like the ones above make the client call tools such as:

- `bitrix_entity_search` `{"entity":"mail_event","eventName":"SALE_NEW_ORDER","includeHandlers":true}` — all `CEvent::Send` calls for an event plus mail handlers.
- `bitrix_entity_search` `{"entity":"module_usage","module":"iblock"}` → `{"entity":"module_usage","count":1,"total":1,"truncated":false,"results":[{"module":"iblock","call":"Loader::includeModule","kind":"project","file":"local/php_interface/init.php","line":2,"signature":"\\Bitrix\\Main\\Loader::includeModule('iblock')"}]}`.
- `bitrix_entity_search` `{"entity":"orm_entity","module":"catalog","limit":50}` — ORM entities with their table names; follow `nextCursor` while `truncated` is `true`.
- `bitrix_entity_search` `{"entity":"inheritance","target":"Bitrix\\Main\\Engine\\Controller","transitive":true}` — all controllers, including indirect subclasses.
- `bitrix_index` `{"scope":"template","templatePath":"local/templates/main"}` — refresh one template after editing it.

## MCP prompts

Clients that show MCP prompts (slash commands in many clients) get three ready-made workflows; their arguments are auto-completed from the index:

- `review-changes` (`base`, default `HEAD~1`): change detection plus impact radius, then a risk report.
- `explain-api` (`symbol`, e.g. `CIBlockElement::GetList`): docs, core definition, and local usages.
- `trace-event` (`module`, `event`, e.g. `main` / `OnBeforeProlog`): handlers, registrations, and what they touch.
