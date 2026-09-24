import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { completeBaseRefs, completeEvents, completeModules, completeSymbols } from "./completions.js";

function userPrompt(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Short workflow prompts; argument values complete from the local index. */
export function registerPrompts(server: McpServer, dbFile: string): void {
  server.registerPrompt(
    "review-changes",
    {
      title: "Review Bitrix changes",
      description: "Review working-tree changes against a git base ref using change detection and impact analysis.",
      argsSchema: {
        base: completable(z.string().optional().describe("Git base ref; default HEAD~1."), (value) => completeBaseRefs(value ?? ""))
      }
    },
    ({ base }) => {
      const ref = base?.trim() || "HEAD~1";
      return userPrompt([
        `Review the changes in this Bitrix project since ${ref}.`,
        `1. Call bitrix_detect_changes with base="${ref}" for changed files, the symbol-level diff, affected Bitrix entities, and risk.`,
        `2. Call bitrix_impact_radius with base="${ref}" and includeRisk=true for events, handlers, components, and ORM entities reached through the graph.`,
        "3. Read the riskiest changed symbols with bitrix_read_symbol_context.",
        "Report: what changed, what it can break (with file:line), and what to test. Flag edits under bitrix/ (core)."
      ].join("\n"));
    }
  );

  server.registerPrompt(
    "explain-api",
    {
      title: "Explain a Bitrix API",
      description: "Explain a Bitrix API symbol from docs, the core definition, and local usages.",
      argsSchema: {
        symbol: completable(z.string().describe("API symbol, e.g. CIBlockElement::GetList or Bitrix\\Main\\Loader."), (value) => completeSymbols(dbFile, value))
      }
    },
    ({ symbol }) => userPrompt([
      `Explain the Bitrix API ${symbol}.`,
      `1. Call bitrix_explain_api_usage with query="${symbol}" (docs, core definition, local usages, relations).`,
      "2. If needed, read the core definition with bitrix_read_symbol_context and more docs with bitrix_docs_for_symbol.",
      "Answer with: signature and parameters, return value, a minimal example, gotchas, and where this project uses it (file:line)."
    ].join("\n"))
  );

  server.registerPrompt(
    "trace-event",
    {
      title: "Trace a Bitrix event",
      description: "Trace who fires and who handles a Bitrix event, and what the handlers touch.",
      argsSchema: {
        module: completable(z.string().describe("Event module id, e.g. main, iblock, sale."), (value) => completeModules(dbFile, value)),
        event: completable(z.string().describe("Event name, e.g. OnAfterIBlockElementAdd."), (value, context) => completeEvents(dbFile, value, context?.arguments?.module))
      }
    },
    ({ module, event }) => userPrompt([
      `Trace the Bitrix event ${module}:${event}.`,
      `1. Call bitrix_event_search with query="${event}" and module="${module}" for registered handlers.`,
      `2. Call bitrix_graph_neighbors with nodeType="event", nodeName="${module}:${event}", direction="both" for registrations and handlers.`,
      "3. Follow each handler with bitrix_graph_traverse (direction out, maxDepth 2) and read it with bitrix_read_symbol_context.",
      "Report the handlers (file:line), their order/registration, and side effects."
    ].join("\n"))
  );
}
