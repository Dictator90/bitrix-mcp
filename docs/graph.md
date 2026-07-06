# Dependency graph and impact radius

Bitrix MCP builds a queryable graph from indexed `bitrix_relations` rather than a generic AST graph. Each edge is a Bitrix relation in the form `source_type:source_name --relation_type--> target_type:target_name`, for example:

- `event:main:OnBeforeProlog --handles_event--> method:Vendor\Module\Handler::onBeforeProlog`
- `file:local/php_interface/init.php --registers_event_handler--> event:main:OnBeforeProlog`
- `component:bitrix:catalog.section --uses_iblock--> iblock:CATALOG_IBLOCK_ID`
- `orm_entity:Vendor\Module\ProductTable --references_orm_entity--> orm_entity:Bitrix\Main\UserTable`

The graph follows Bitrix concepts that are often dynamic or configured through framework APIs: events and handlers, module includes, agents, mail events, ORM entity references, components/templates, iblock and highloadblock usage, options, assets, and PHP inheritance.

## Tools

- `bitrix_relation_search` — edge lookup.
- `bitrix_graph_neighbors` — direct or bounded-depth neighbors. Params: `nodeType`, `nodeName`, `direction` (`out`/`in`/`both`), `relationType`, `depth`, `limit`, `format`.
- `bitrix_graph_traverse` — safe BFS with cycle protection. Params: `startType`, `startName`, `direction`, `maxDepth`, `relationTypes`, `limit`, `format`.
- `bitrix_impact_radius` — starts from given files or `git diff --name-only <base>` (default `HEAD~1`) and groups impacted events, handlers, components, templates, ORM entities, agents, mail events, iblocks, hlblocks, modules, options, classes, and methods. With `includeRisk`, it weights high-impact relations such as `handles_event`, `registers_event_handler`, `registers_agent`, `sends_mail_event`, `references_orm_entity`, `includes_component`, `uses_template`, `extends`, and `implements`.

Traversals are intentionally bounded by depth and result limits.

## Examples

```text
bitrix_graph_neighbors({ "nodeType": "event", "nodeName": "main:OnBeforeProlog", "direction": "both" })

bitrix_graph_traverse({ "startType": "component", "startName": "bitrix:catalog.section",
  "maxDepth": 2, "relationTypes": ["uses_iblock", "uses_template"] })

bitrix_impact_radius({ "files": ["local/php_interface/init.php"], "maxDepth": 2, "includeRisk": true })
```

CLI equivalents for quick inspection:

```bash
bitrix-mcp graph-neighbors event main:OnBeforeProlog --direction both
bitrix-mcp impact-radius local/php_interface/init.php --depth 2
```
