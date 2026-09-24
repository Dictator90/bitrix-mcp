import { z } from "zod";

/** Index kinds a search can be restricted to. */
export const INDEX_KINDS = ["project", "bitrix", "template", "install"] as const;
export const indexKindSchema = z.enum(INDEX_KINDS);
export const searchKindSchema = z.union([indexKindSchema, z.array(indexKindSchema).min(1).max(4)]);
export const KIND_DESCRIPTION = "Restrict to one index kind or an array of kinds: project, template, bitrix (core), install (module install/ assets).";

export const formatSchema = z.enum(["compact", "full"]).optional().describe("compact (default) returns short fields; full returns raw indexed records.");

/** Graph node types stored in bitrix_relations (source_type/target_type). */
export const GRAPH_NODE_TYPES = [
  "file", "module", "event", "method", "function", "class", "component", "template", "agent", "mail_event",
  "iblock", "hlblock", "option", "orm_entity", "asset", "namespace_prefix", "package", "directory", "bootstrap"
] as const;

/** Relation (edge) types stored in bitrix_relations. */
export const RELATION_TYPES = [
  "registers_event_handler", "handles_event", "includes_module", "registers_agent", "removes_agent", "queries_agents",
  "calls_method", "sends_mail_event", "handles_mail_event", "includes_component", "uses_template", "uses_asset",
  "uses_iblock", "uses_hlblock", "uses_option", "defines_option", "defines_orm_entity", "uses_orm_entity",
  "references_orm_entity", "extends", "implements", "uses_trait", "autoloads_from", "is_dependency", "is_bootstrap"
] as const;

export const NODE_TYPES_DESCRIPTION = `Node types: ${GRAPH_NODE_TYPES.join(", ")}. Classes, interfaces and traits are all "class".`;
export const RELATION_TYPES_DESCRIPTION = `Relation types: ${RELATION_TYPES.join(", ")}.`;

export const searchFormatShape = {
  includeSignature: z.boolean().optional().describe("Include the compact signature field; default true."),
  maxSignatureChars: z.number().int().min(20).max(2_000).optional().describe("Maximum characters for compact signatures; default 160."),
  maxTextChars: z.number().int().min(80).max(10_000).optional().describe("Maximum characters for documentation excerpts in compact mode; default 500."),
  format: formatSchema
};
