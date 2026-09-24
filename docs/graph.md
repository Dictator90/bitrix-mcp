# Dependency graph and impact radius

Bitrix MCP builds a queryable graph from indexed `bitrix_relations` rather than a generic AST graph. Each edge is a Bitrix relation in the form `source_type:source_name --relation_type--> target_type:target_name`, for example:

- `event:main:OnBeforeProlog --handles_event--> method:Vendor\Module\Handler::onBeforeProlog`
- `file:local/php_interface/init.php --registers_event_handler--> event:main:OnBeforeProlog`
- `component:bitrix:catalog.section --uses_iblock--> iblock:CATALOG_IBLOCK_ID`
- `orm_entity:Vendor\Module\ProductTable --references_orm_entity--> orm_entity:Bitrix\Main\UserTable`
- `class:Vendor\Module\ProductTable --extends--> class:Bitrix\Main\ORM\Data\DataManager`

The graph follows Bitrix concepts that are often dynamic or configured through framework APIs: events and handlers, module includes, agents, mail events, ORM entity references, components/templates, iblock and highloadblock usage, options, assets, and PHP inheritance.

## Node identity

- **Class-like nodes are always `class:<FQN>`.** Classes, interfaces and traits share the `class` node type, and inheritance edges point at `class:<FQN>` for parents, interfaces and traits alike. The relation type says which it is: `extends`, `implements` or `uses_trait` (the edge metadata also records `targetKind`: `class`, `interface` or `trait`). Because the declaration's own node and the edges that reference it are the same node, inheritance chains can be walked: `class:Leaf --extends--> class:Middle --extends--> class:Base --implements--> class:Contract`.
- **Legacy rows are read transparently.** Indexes written by older versions used `parent_class:`, `interface:` and `trait:` target types. Readers treat those types as aliases of `class` (a start node `interface:Foo` is the same as `class:Foo`), and a re-index rewrites them.
- **PHP names are case-insensitive.** For `class`, `method`, `function` and `orm_entity` nodes, names are compared case-insensitively and a leading backslash is ignored, as in PHP: `class:\VENDOR\Module\base` and `class:Vendor\Module\Base` are one node. The display case of the first node reached is kept, and edges use that node's id. The comparison uses `COLLATE NOCASE` at query time, so no stored data changes.
- `file` and `template` names are slash-normalized (`/`).

## Tools

- `bitrix_relation_search`: edge lookup. `sourceType`/`targetType` `class` also matches the legacy class-like types, and PHP names are matched case-insensitively.
- `bitrix_inheritance_search`: classes that extend, implement or use a target. A target with a backslash matches that exact FQN; a short name matches only the last namespace segment exactly (`Base` matches `Foo\Base`, not `Foo\MyBase`). With `transitive: true` it also returns indirect descendants, breadth-first up to `maxDepth` (default 5, max 10), cycle-safe, each result with `depth` (`metadata.depth` and `metadata.via` in full format). Deeper levels follow `extends` too, because subclasses inherit their parents' interfaces and traits. `kind`/`module` filter the returned rows only, so a project class extending a core class that implements the target is still found.
- `bitrix_graph_neighbors`: direct or bounded-depth neighbors. Params: `nodeType`, `nodeName`, `direction` (`out`/`in`/`both`), `relationType`, `depth`, `limit`, `maxEdgesPerNode`, `format`.
- `bitrix_graph_traverse`: safe BFS with cycle protection. Params: `startType`, `startName`, `direction`, `maxDepth`, `relationTypes`, `limit`, `maxEdgesPerNode`, `format`.
- `bitrix_impact_radius`: starts from the given files, or from the files changed since `base` (default `HEAD~1`, including untracked files), and groups impacted events, handlers, components, templates, ORM entities, agents, mail events, iblocks, hlblocks, modules, options, classes, and methods. Start nodes are the files, the endpoints of their relations, and the graph nodes of their indexed symbols. Methods start as `method:<Class FQN>::<method>`, so a changed handler class reaches the events that call it. With `includeRisk`, it weights high-impact relations such as `handles_event`, `registers_event_handler`, `registers_agent`, `sends_mail_event`, `references_orm_entity`, `includes_component`, `uses_template`, `extends`, and `implements`. If git fails (not a repository, unknown base), the result has no changed files and a `warnings` array says why.

## Bounds and performance

Every traversal is bounded and cycle-safe:

- **Depth.** `maxDepth` / `depth` is clamped (traverse and impact up to 8, neighbors up to 5).
- **Result size.** `limit` caps both nodes and edges (up to 1000). Reaching it sets `truncated: true`.
- **Hub nodes.** `maxEdgesPerNode` caps the edges read per node and direction. It defaults to `limit`, which reads nothing that could be returned anyway. A hub such as `module:iblock` with thousands of incoming edges returns at most that many, sets `truncated: true` and appears in `truncatedNodes`.
- **Cycles.** Each node is expanded once, at its shortest depth.

A traversal uses one read-only SQLite connection and reads a whole BFS level at a time. It runs one query per node type, direction and chunk of 400 names, and `ROW_NUMBER()` applies the per-node cap inside SQLite. `bitrix_impact_radius` expands all start nodes together in a single multi-source BFS. This returns the same nodes and edges as one traversal per start node, without opening a connection or re-reading shared neighborhoods for each one.

## Examples

```text
bitrix_graph_neighbors({ "nodeType": "event", "nodeName": "main:OnBeforeProlog", "direction": "both" })

bitrix_graph_traverse({ "startType": "class", "startName": "Vendor\\Module\\Leaf",
  "maxDepth": 4, "relationTypes": ["extends", "implements", "uses_trait"] })

bitrix_graph_traverse({ "startType": "component", "startName": "bitrix:catalog.section",
  "maxDepth": 2, "relationTypes": ["uses_iblock", "uses_template"] })

bitrix_inheritance_search({ "target": "Bitrix\\Main\\ORM\\Data\\DataManager", "relation": "extends", "transitive": true })

bitrix_impact_radius({ "files": ["local/php_interface/init.php"], "maxDepth": 2, "includeRisk": true })
```

CLI equivalents for quick inspection:

```bash
bitrix-mcp graph-neighbors event main:OnBeforeProlog --direction both
bitrix-mcp impact-radius local/php_interface/init.php --depth 2
```
