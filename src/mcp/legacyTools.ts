import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { toolAnnotations } from "./annotations.js";
import { resultEnvelopeShape } from "./envelope.js";
import { entitySearchShape, type EntitySearchInput, type EntityType } from "./entitySearch.js";
import type { McpToolGuardOptions } from "./toolGuards.js";

export const INDEX_SCOPES = ["project", "template", "bitrix", "install", "docs", "all"] as const;

export const indexToolShape = {
  scope: z.enum(INDEX_SCOPES).describe("What to index: project, template, bitrix (core modules), install (module install/ assets), docs, or all."),
  root: z.string().optional().describe("scope=project: directory to index, inside the workspace; default the workspace root."),
  templatePath: z.string().optional().describe("scope=template: template directory relative to the workspace, e.g. local/templates/site; default all templates."),
  modules: z.array(z.string().min(1)).max(200).optional().describe("scope=bitrix: core module ids to index, e.g. [\"main\", \"iblock\"]; default all modules."),
  includeInstall: z.boolean().optional().describe("scope=all: also index module install/ assets (slow on large cores); default false.")
};

export type IndexToolArgs = z.infer<z.ZodObject<typeof indexToolShape>>;

export interface LegacyToolHandlers {
  runEntity: (toolName: string, input: EntitySearchInput, extra?: McpToolGuardOptions) => Promise<CallToolResult>;
  runIndex: (toolName: string, args: IndexToolArgs, extra?: McpToolGuardOptions) => Promise<CallToolResult>;
}

type EntityField = keyof typeof entitySearchShape;

interface LegacyEntityTool {
  entity: EntityType;
  /** Old parameter names mapped to bitrix_entity_search fields (same name when omitted). */
  fields: Array<EntityField | [legacyName: string, field: EntityField]>;
}

/** 0.8 per-entity search tools, now thin wrappers over bitrix_entity_search. */
export const LEGACY_ENTITY_TOOLS: Record<string, LegacyEntityTool> = {
  bitrix_agent_search: { entity: "agent", fields: ["query", "module", "kind", "file"] },
  bitrix_mail_event_search: { entity: "mail_event", fields: ["query", "eventName", "api", "kind", "file", "includeHandlers"] },
  bitrix_component_search: { entity: "component", fields: ["query", "component", "template", "kind", "file"] },
  bitrix_module_usage_search: { entity: "module_usage", fields: ["module", "call", "kind", "file"] },
  bitrix_iblock_usage_search: { entity: "iblock_usage", fields: ["query", "iblockId", "api", "kind", "file"] },
  bitrix_hlblock_usage_search: { entity: "hlblock_usage", fields: ["query", "hlblockId", "api", "kind", "file"] },
  bitrix_option_search: { entity: "option", fields: ["query", "module", "name", "operation", "api", "kind", "file"] },
  bitrix_orm_search: { entity: "orm_entity", fields: ["query", "tableName", "className", "module", "kind"] },
  bitrix_orm_usage_search: { entity: "orm_usage", fields: ["query", ["entity", "ormEntity"], "method", "file", "kind"] },
  bitrix_autoload_search: { entity: "autoload", fields: ["query", "namespace", "package", ["type", "autoloadType"]] },
  bitrix_relation_search: { entity: "relation", fields: ["sourceType", "sourceName", "targetType", "targetName", "relationType", "module", "kind", "file"] },
  bitrix_inheritance_search: { entity: "inheritance", fields: ["target", "relation", "kind", "module", "transitive", "maxDepth"] }
};

/** 0.8 index tools and the bitrix_index scope each maps to. */
export const LEGACY_INDEX_TOOLS: Record<string, { scope: IndexToolArgs["scope"]; shape: ZodRawShape; description: string }> = {
  bitrix_index_project: { scope: "project", shape: { root: indexToolShape.root }, description: "Deprecated: use bitrix_index with scope=project." },
  bitrix_index_template: {
    scope: "template",
    shape: { templatePath: indexToolShape.templatePath, root: z.string().optional().describe("Deprecated alias of templatePath.") },
    description: "Deprecated: use bitrix_index with scope=template."
  },
  bitrix_index_all: { scope: "all", shape: { includeInstall: indexToolShape.includeInstall }, description: "Deprecated: use bitrix_index with scope=all." },
  bitrix_index_docs: { scope: "docs", shape: {}, description: "Deprecated: use bitrix_index with scope=docs." }
};

const LEGACY_LIMIT = z.number().int().min(1).max(100).default(20).describe("Page size, 1-100; default 20.");

function legacyEntityShape(tool: LegacyEntityTool): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const entry of tool.fields) {
    const [legacyName, field] = Array.isArray(entry) ? entry : [entry, entry];
    shape[legacyName] = entitySearchShape[field];
  }
  if (tool.entity === "inheritance") shape.target = z.string().min(1).describe(entitySearchShape.target.description ?? "Parent class, interface, or trait.");
  return { ...shape, limit: LEGACY_LIMIT, cursor: entitySearchShape.cursor, format: entitySearchShape.format };
}

/**
 * Registers the 0.8 tool names (BITRIX_MCP_LEGACY_TOOLS=1) as thin
 * wrappers: entity searches forward to bitrix_entity_search and index tools
 * to bitrix_index. Output is the new envelope. Removed in the next release.
 */
export function registerLegacyTools(server: McpServer, handlers: LegacyToolHandlers): void {
  for (const [name, tool] of Object.entries(LEGACY_ENTITY_TOOLS)) {
    server.registerTool(name, {
      title: `${name} (deprecated)`,
      description: `Deprecated: use bitrix_entity_search with entity=${tool.entity}. Same filters; returns the paginated result envelope.`,
      inputSchema: legacyEntityShape(tool),
      outputSchema: resultEnvelopeShape,
      annotations: toolAnnotations(name)
    }, async (args: Record<string, unknown>, extra) => {
      const input: Record<string, unknown> = { entity: tool.entity, limit: args.limit, cursor: args.cursor, format: args.format };
      for (const entry of tool.fields) {
        const [legacyName, field] = Array.isArray(entry) ? entry : [entry, entry];
        input[field] = args[legacyName];
      }
      return handlers.runEntity(name, input as EntitySearchInput, extra);
    });
  }

  for (const [name, tool] of Object.entries(LEGACY_INDEX_TOOLS)) {
    server.registerTool(name, {
      title: `${name} (deprecated)`,
      description: tool.description,
      inputSchema: tool.shape,
      annotations: toolAnnotations(name)
    }, async (args: Record<string, unknown>, extra) => handlers.runIndex(name, { ...args, scope: tool.scope } as IndexToolArgs, extra));
  }
}
