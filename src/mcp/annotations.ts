import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const INDEX: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * MCP tool annotations: every tool is a local read unless listed here. Index
 * tools write only the local SQLite index; tools that can change the project
 * or its database are marked destructive so clients ask before running them.
 */
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  bitrix_index_project: INDEX,
  bitrix_index_template: INDEX,
  bitrix_index_all: { ...INDEX, openWorldHint: true },
  bitrix_index_docs: { ...INDEX, openWorldHint: true },
  bitrix_db_execute: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  bitrix_tinker: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};

export function toolAnnotations(name: string): ToolAnnotations {
  return TOOL_ANNOTATIONS[name] ?? READ_ONLY;
}

/** Makes every tool registered on `server` through `server.tool(...)` carry {@link toolAnnotations}. */
export function annotateRegisteredTools(server: McpServer): void {
  const register = server.tool.bind(server) as (...args: unknown[]) => RegisteredTool;
  server.tool = ((...args: unknown[]) => {
    const registered = register(...args);
    registered.update({ annotations: toolAnnotations(String(args[0])) });
    return registered;
  }) as McpServer["tool"];
}

export const CONFIRM_DANGEROUS_ENV = "BITRIX_MCP_CONFIRM_DANGEROUS";

/**
 * Asks the user to approve a destructive call through MCP elicitation when the
 * client supports it. Clients without elicitation rely on their own tool
 * approval (the tools are annotated `destructiveHint`). Disable with
 * BITRIX_MCP_CONFIRM_DANGEROUS=0. Throws when the user declines.
 */
export async function confirmDangerousCall(server: McpServer, toolName: string, details: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env[CONFIRM_DANGEROUS_ENV] === "0") return;
  if (!server.server.getClientCapabilities()?.elicitation) return;
  const preview = details.length > 2000 ? `${details.slice(0, 2000)}\n…[truncated]` : details;
  const result = await server.server.elicitInput({
    message: `${toolName} wants to run the following on your local Bitrix project. Allow it?\n\n${preview}`,
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", title: "Allow this call", description: "Run it once." } },
      required: ["confirm"]
    }
  });
  if (result.action !== "accept" || result.content?.confirm !== true) {
    throw new Error(`${toolName} was not run: the user did not approve it.`);
  }
}
