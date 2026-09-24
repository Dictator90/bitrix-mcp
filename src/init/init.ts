import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stderr as output } from "node:process";
import fg from "fast-glob";
import { resolveHomeDir } from "../config/home.js";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { buildIndex, DEFAULT_BITRIX_PATTERNS } from "../indexer/indexer.js";
import { hasIndexMetadata } from "../indexer/sqliteStore.js";
import { serveStdio } from "../mcp/server.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { createProgressReporter, detectCi, type ProgressReporter } from "../progress/index.js";
import {
  getJsonValue,
  isPlainObject,
  loadJsonConfig,
  readTextFileIfExists,
  replaceTomlTable,
  saveJsonConfig,
  setJsonValue,
  writeTextIfChanged,
  type JsonConfigDocument,
  type WriteOutcome
} from "./configFiles.js";

export type Agent =
  | "cursor"
  | "claude-code"
  | "jetbrains"
  | "vscode"
  | "windsurf"
  | "cline"
  | "roo-code"
  | "continue"
  | "gemini-cli"
  | "codex"
  | "kilo-code"
  | "generic-json";

interface AgentChoice {
  id: Agent;
  label: string;
  description: string;
}

export const AGENT_CHOICES: AgentChoice[] = [
  { id: "cursor", label: "Cursor", description: "project config in .cursor/mcp.json" },
  { id: "claude-code", label: "Claude Code", description: "project config in .mcp.json (also used by Claude Desktop)" },
  { id: "jetbrains", label: "PhpStorm / JetBrains", description: "JSON snippet for JetBrains AI Assistant" },
  { id: "vscode", label: "VS Code / GitHub Copilot", description: "project config in .vscode/mcp.json" },
  { id: "windsurf", label: "Windsurf", description: "global config in ~/.codeium/windsurf/mcp_config.json" },
  { id: "cline", label: "Cline", description: "global config in ~/.cline/data/settings/cline_mcp_settings.json" },
  { id: "roo-code", label: "Roo Code", description: "project config in .roo/mcp.json" },
  { id: "continue", label: "Continue", description: "project JSON block in .continue/mcpServers/bitrix-mcp.json" },
  { id: "gemini-cli", label: "Gemini CLI", description: "project config in .gemini/settings.json" },
  { id: "codex", label: "OpenAI Codex", description: "global config in ~/.codex/config.toml" },
  { id: "kilo-code", label: "Kilo Code", description: "global CLI config in ~/.kilocode/cli/global/settings/mcp_settings.json" },
  { id: "generic-json", label: "Другой MCP-клиент", description: "custom JSON config path with an mcpServers object" }
];

export interface InitContext {
  projectRoot: string;
  dataDir: string;
  docsDir: string;
  bitrixRoot?: string;
  embeddingsUrl: string;
  semanticEnabled: boolean;
  dbEnabled: boolean;
  dbAllowWrite: boolean;
  tinkerEnabled: boolean;
  phpBin: string;
  /** Home directory for global client configs; defaults to BITRIX_MCP_HOME_DIR or os.homedir(). */
  homeDir?: string;
}

export interface WrittenConfig {
  label: string;
  path?: string;
  note?: string;
  outcome?: WriteOutcome;
}

export interface AgentGuidanceResult {
  label: string;
  path: string;
  outcome?: WriteOutcome;
  /** Set when the file was intentionally skipped (e.g. user-owned hook file). */
  warning?: string;
}

const BITRIX_MCP_SKILL = `---
name: bitrix-mcp
description: Use when working on Bitrix Framework projects with the bitrix-mcp MCP server; searching Bitrix documentation, LiveAPI indexes, event handlers, templates, and project symbols; or deciding when to reindex project/template/Bitrix sources.
---

# Bitrix MCP

Use the configured \`bitrix-mcp\` MCP server as the primary authoritative reference source for Bitrix Framework projects.

## Authority Rule

Treat Bitrix MCP tool results as the primary source of truth for:
- project symbols and Bitrix framework symbols;
- event handlers and module usages;
- agents, mail events, and ORM entities;
- components, templates, and IBlock/Highloadblock/options usage;
- relations, graph impact, and local indexed documentation.

If a Bitrix MCP tool returns a successful, non-empty result, use it as the primary evidence. Do not manually scan project files for the same information unless:
1. the user explicitly asked to search or read files manually;
2. the MCP result is empty;
3. the MCP result indicates that a relevant index is missing or stale;
4. the result is ambiguous and requires additional context;
5. the requested information is outside Bitrix MCP coverage.

## Workflow

1. **Orientation**: Call \`bitrix_index_status\` and \`bitrix_project_overview\` first to understand the project structure, autoloading, and index health.
2. **Review/Impact**: Use \`bitrix_detect_changes\` for review tasks. Use \`bitrix_impact_radius\`, \`bitrix_graph_neighbors\`, or \`bitrix_graph_traverse\` for dependency analysis and risk assessment.
3. **Search**: Use \`bitrix_liveapi_search\`, \`bitrix_event_search\`, or \`bitrix_docs_search\` to find symbols, handlers, or documentation.
4. **Inspection**: Use \`bitrix_read_symbol_context\` or \`bitrix_read_file_context\` after a search returns a file and line number.
5. **Direct search**: Use manual file search/grep only as a fallback when MCP tools are insufficient or the index is stale.
6. **Live DB (optional)**: When \`BITRIX_MCP_DB_ENABLED=1\`, after static search you can inspect real data via \`bitrix_db_connections\` → \`bitrix_db_schema\` → \`bitrix_db_query\` (read-only; use \`bitrix_db_execute\` for writes only when \`BITRIX_MCP_DB_ALLOW_WRITE=1\`).
7. **Live PHP (optional, local dev only)**: When \`BITRIX_MCP_TINKER_ENABLED=1\`, you can run arbitrary PHP against the loaded Bitrix kernel via \`bitrix_tinker\` (return a value with \`return <expr>;\`) — powerful for runtime checks, but it executes real code and can write to the local dev machine.

## Stale Indexes

If MCP returns no result for something that should exist:
1. Check \`bitrix_index_status\`.
2. Ask to run or run the relevant indexing tool (\`bitrix_index_project\`, \`bitrix_index_template\`, \`bitrix_index_docs\`, or \`bitrix_index_all\`).
3. Retry the MCP query before falling back to manual search.

## Safety

- Do not edit Bitrix core under \`bitrix/\` unless the user explicitly requests it.
- Prefer extending code under \`local/\`, project templates, or project modules.
`;

const BITRIX_MCP_RULES = `# Bitrix MCP rules

## Authority Rule
Treat \`bitrix-mcp\` tool results as the primary source of truth for Bitrix Framework and project indexed data. Do not manually scan files if MCP returned a successful result unless it is empty, stale, or manual search was explicitly requested. When DB access is enabled, real project data comes from \`bitrix_db_*\` tools rather than guesses. When tinker is enabled, \`bitrix_tinker\` can execute PHP with the Bitrix kernel loaded for runtime checks.

## Recommended Workflow
1. Call \`bitrix_index_status\` and \`bitrix_project_overview\` first.
2. Use \`bitrix_detect_changes\` and impact tools for changes/reviews.
3. Use \`bitrix_liveapi_search\`, \`bitrix_event_search\`, and \`bitrix_docs_search\` for discovery.
4. Use \`bitrix_read_symbol_context\` or \`bitrix_read_file_context\` for source inspection.
5. Manual file search is a fallback, not the default.

## Stale Indexes
If MCP returns no results for expected data, check \`bitrix_index_status\`, run the relevant reindexing tool (e.g., \`bitrix_index_all\`), and retry the query.

## Safety
Do not edit Bitrix core under \`bitrix/\` unless explicitly requested; prefer \`local/\`, project modules, and templates.
`;

export const GUIDANCE_SECTION_START = "<!-- bitrix-mcp:init-guidance:start -->";
export const GUIDANCE_SECTION_END = "<!-- bitrix-mcp:init-guidance:end -->";

/**
 * Sentinel appended (as a shell comment) to every hook command bitrix-mcp
 * manages, so re-running init/configure (or uninstall) can find exactly its
 * own hooks without touching user-authored ones.
 */
export const BITRIX_MCP_HOOK_MARKER = "bitrix-mcp:auto-directive";
const BITRIX_MCP_TOOL_PREFIX = "mcp__bitrix-mcp__";
const BITRIX_MCP_HOOK_TOOLS = [
  "bitrix_index_status",
  "bitrix_project_overview",
  "bitrix_liveapi_search",
  "bitrix_docs_search",
  "bitrix_read_symbol_context",
  "bitrix_detect_changes"
];

function hookToolSelect(tools: string[]): string {
  return `select:${tools.map((tool) => `${BITRIX_MCP_TOOL_PREFIX}${tool}`).join(",")}`;
}

// Directive texts. Kept ASCII-only and free of single quotes so they survive
// being wrapped in a single-quoted `echo` argument on both bash and PowerShell.

/**
 * Claude Code defers MCP tools behind its ToolSearch mechanism, so the session
 * is told once (SessionStart) to load them before anything else.
 */
function claudeSessionDirective(): string {
  return `[bitrix-mcp] 1C-Bitrix project with the bitrix-mcp MCP server. For Bitrix tasks, first load its tools via ToolSearch (${hookToolSelect(BITRIX_MCP_HOOK_TOOLS)}), start with bitrix_index_status and bitrix_project_overview, and treat MCP results as the primary source of truth. Manual grep/read is a fallback when MCP is empty, stale, or explicitly requested.`;
}

/** Same as above, injected into every spawned Claude Code subagent at start. */
function claudeSubagentDirective(): string {
  return `[bitrix-mcp] 1C-Bitrix project. For Bitrix tasks, first load bitrix-mcp tools via ToolSearch (${hookToolSelect(BITRIX_MCP_HOOK_TOOLS.slice(0, 5))}) and treat them as the primary source of truth; manual file search is a fallback.`;
}

/**
 * Directive for agents that expose MCP tools directly (Gemini CLI, Cursor, ...),
 * so there is no ToolSearch step — only the Authority Rule.
 */
function directToolsDirective(): string {
  return "[bitrix-mcp] 1C-Bitrix project with the bitrix-mcp MCP server. For Bitrix tasks, use its tools as the primary source of truth: start with bitrix_index_status and bitrix_project_overview, then bitrix_liveapi_search, bitrix_docs_search, bitrix_detect_changes, bitrix_read_symbol_context. Manual grep/read is a fallback when MCP is empty, stale, or explicitly requested.";
}

/** Wrap a hook JSON payload in a marked, single-quoted `echo` shell command. */
function hookEchoCommand(payload: Record<string, unknown>): string {
  return `echo '${JSON.stringify(payload)}' # ${BITRIX_MCP_HOOK_MARKER}`;
}

/** Command for the Claude Code / Gemini CLI `hookSpecificOutput` context shape. */
function contextHookCommand(event: string, additionalContext: string): string {
  return hookEchoCommand({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

/** Command for the Cursor `additional_context` sessionStart shape. */
function cursorContextCommand(additionalContext: string): string {
  return hookEchoCommand({ additional_context: additionalContext });
}

export function isManagedHookEntry(entry: unknown): boolean {
  return JSON.stringify(entry).includes(BITRIX_MCP_HOOK_MARKER);
}

function hooksObject(doc: JsonConfigDocument): Record<string, unknown> {
  const hooks = getJsonValue(doc, ["hooks"]);
  if (hooks === undefined) {
    return {};
  }
  if (!isPlainObject(hooks)) {
    throw new Error(`Cannot update hooks in ${doc.filePath}: "hooks" is not an object. bitrix-mcp did not modify it.`);
  }
  return hooks;
}

/** Replace our previous managed entry for `event` (if any) and append the fresh one. */
function upsertManagedHook(doc: JsonConfigDocument, event: string, entry: Record<string, unknown>): void {
  const current = hooksObject(doc)[event];
  const existing = Array.isArray(current) ? current : [];
  setJsonValue(doc, ["hooks", event], [...existing.filter((item) => !isManagedHookEntry(item)), entry]);
}

/**
 * Drops our managed entries from `event` (and the event key itself if nothing
 * else is left). Returns true when something was removed.
 */
export function removeManagedHooks(doc: JsonConfigDocument, event: string): boolean {
  const current = hooksObject(doc)[event];
  if (!Array.isArray(current) || !current.some(isManagedHookEntry)) {
    return false;
  }
  const remaining = current.filter((item) => !isManagedHookEntry(item));
  setJsonValue(doc, ["hooks", event], remaining.length > 0 ? remaining : undefined);
  return true;
}

function guidanceResult(label: string, filePath: string, outcome: WriteOutcome): AgentGuidanceResult {
  return { label, path: filePath, outcome };
}

export function claudeSettingsPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".claude", "settings.json");
}

/**
 * Claude Code hooks (`.claude/settings.json`): SessionStart injects the
 * directive once per session (also after /clear and compaction) and
 * SubagentStart covers spawned agents. Earlier releases used a per-prompt
 * UserPromptSubmit hook; that managed entry is removed on re-run. Merges into
 * any existing config, preserving user settings/hooks/comments.
 */
export async function writeClaudeCodeHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = claudeSettingsPath(context);
  const doc = await loadJsonConfig(filePath);
  removeManagedHooks(doc, "UserPromptSubmit");
  upsertManagedHook(doc, "SessionStart", {
    hooks: [{ type: "command", command: contextHookCommand("SessionStart", claudeSessionDirective()), statusMessage: "bitrix-mcp directive" }]
  });
  upsertManagedHook(doc, "SubagentStart", {
    hooks: [{ type: "command", command: contextHookCommand("SubagentStart", claudeSubagentDirective()), statusMessage: "bitrix-mcp directive" }]
  });
  return guidanceResult("Claude Code hooks", filePath, await saveJsonConfig(doc));
}

export function geminiSettingsPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".gemini", "settings.json");
}

/**
 * Gemini CLI hooks (`.gemini/settings.json`): the BeforeAgent event injects
 * context before each agent turn (Gemini has no subagent-start event). Shares
 * the file with the MCP server config and merges non-destructively.
 */
export async function writeGeminiHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = geminiSettingsPath(context);
  const doc = await loadJsonConfig(filePath);
  upsertManagedHook(doc, "BeforeAgent", {
    matcher: "*",
    hooks: [{ type: "command", name: "bitrix-mcp-directive", command: contextHookCommand("BeforeAgent", directToolsDirective()) }]
  });
  return guidanceResult("Gemini CLI hooks", filePath, await saveJsonConfig(doc));
}

export function cursorHooksPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".cursor", "hooks.json");
}

/**
 * Cursor hooks (`.cursor/hooks.json`): context injection is only supported on
 * the sessionStart event (via `additional_context`); beforeSubmitPrompt cannot
 * inject context. Requires a top-level `version` field.
 */
export async function writeCursorHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = cursorHooksPath(context);
  const doc = await loadJsonConfig(filePath);
  if (typeof getJsonValue(doc, ["version"]) !== "number") {
    setJsonValue(doc, ["version"], 1);
  }
  upsertManagedHook(doc, "sessionStart", { command: cursorContextCommand(directToolsDirective()) });
  return guidanceResult("Cursor hooks", filePath, await saveJsonConfig(doc));
}

export function codexHooksPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".codex", "hooks.json");
}

/**
 * Codex hooks (`.codex/hooks.json`): the SessionStart event injects developer
 * context. Same `hookSpecificOutput.additionalContext` shape as Claude Code.
 * Merges non-destructively; project-local hooks load once the `.codex/` layer
 * is trusted.
 */
export async function writeCodexHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = codexHooksPath(context);
  const doc = await loadJsonConfig(filePath);
  upsertManagedHook(doc, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: contextHookCommand("SessionStart", directToolsDirective()) }]
  });
  return guidanceResult("Codex hooks", filePath, await saveJsonConfig(doc));
}

export function copilotHooksPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".github", "hooks", "bitrix-mcp.json");
}

function userOwnedWarning(filePath: string): string {
  return `${filePath} exists and was not created by bitrix-mcp (no ${BITRIX_MCP_HOOK_MARKER} marker); left unchanged.`;
}

/**
 * GitHub Copilot / VS Code agent hooks. VS Code auto-loads every `.json` under
 * `.github/hooks/`, so bitrix-mcp owns a dedicated file. The SessionStart event
 * injects context via `hookSpecificOutput.additionalContext`. An existing file
 * without our marker is treated as user-owned and left alone.
 */
export async function writeCopilotHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = copilotHooksPath(context);
  const previous = await readTextFileIfExists(filePath);
  if (previous !== undefined && !previous.includes(BITRIX_MCP_HOOK_MARKER)) {
    return { label: "Copilot hooks", path: filePath, outcome: "unchanged", warning: userOwnedWarning(filePath) };
  }
  const next = `${JSON.stringify({
    hooks: {
      SessionStart: [
        { type: "command", command: contextHookCommand("SessionStart", directToolsDirective()) }
      ]
    }
  }, null, 2)}\n`;
  return guidanceResult("Copilot hooks", filePath, await writeTextIfChanged(filePath, next, { previous }));
}

export function clineHookPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".clinerules", "hooks", "UserPromptSubmit");
}

/**
 * Cline hooks are executable scripts named exactly after the hook type (no
 * extension) under `.clinerules/hooks/`. The UserPromptSubmit script emits
 * `{"contextModification": ...}` to inject context. Cline runs hooks on
 * macOS/Linux only, so the file is a `bash` script marked executable. An
 * existing script without our marker is user-owned and left alone.
 */
export async function writeClineHooks(context: InitContext): Promise<AgentGuidanceResult> {
  const filePath = clineHookPath(context);
  const previous = await readTextFileIfExists(filePath);
  if (previous !== undefined && !previous.includes(BITRIX_MCP_HOOK_MARKER)) {
    return { label: "Cline hooks", path: filePath, outcome: "unchanged", warning: userOwnedWarning(filePath) };
  }
  const payload = JSON.stringify({ contextModification: directToolsDirective() });
  const script = `#!/usr/bin/env bash\n# ${BITRIX_MCP_HOOK_MARKER}\ncat <<'BITRIX_MCP_JSON'\n${payload}\nBITRIX_MCP_JSON\n`;
  return guidanceResult("Cline hooks", filePath, await writeTextIfChanged(filePath, script, { previous, mode: 0o755 }));
}

/** Agents that support context-injection hooks, mapped to their hook writer. */
const HOOK_WRITERS: Partial<Record<Agent, (context: InitContext) => Promise<AgentGuidanceResult>>> = {
  "claude-code": writeClaudeCodeHooks,
  "gemini-cli": writeGeminiHooks,
  cursor: writeCursorHooks,
  codex: writeCodexHooks,
  vscode: writeCopilotHooks,
  cline: writeClineHooks
};

async function writeTextFile(filePath: string, value: string, label = "Bitrix MCP guidance"): Promise<AgentGuidanceResult> {
  const outcome = await writeTextIfChanged(filePath, value.endsWith("\n") ? value : `${value}\n`);
  return guidanceResult(label, filePath, outcome);
}

function markedSection(section: string): string {
  return `${GUIDANCE_SECTION_START}\n${section.trim()}\n${GUIDANCE_SECTION_END}`;
}

export const GUIDANCE_SECTION_PATTERN = new RegExp(`${GUIDANCE_SECTION_START}[\\s\\S]*?${GUIDANCE_SECTION_END}`);

function upsertSection(source: string, section: string): string {
  const normalizedSection = markedSection(section);
  return GUIDANCE_SECTION_PATTERN.test(source)
    ? source.replace(GUIDANCE_SECTION_PATTERN, normalizedSection)
    : `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${normalizedSection}\n`;
}

async function upsertMarkedSection(filePath: string, section: string, label: string, newFileTemplate?: string): Promise<AgentGuidanceResult> {
  const source = await readTextFileIfExists(filePath);
  const next = source === undefined ? newFileTemplate ?? `${markedSection(section)}\n` : upsertSection(source, section);
  return guidanceResult(label, filePath, await writeTextIfChanged(filePath, next.endsWith("\n") ? next : `${next}\n`, { previous: source }));
}

export function splitMarkdownFrontmatter(source: string): { frontmatter: string; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: "", body: source };
  }

  const closingMarker = "\n---";
  const closingIndex = source.indexOf(closingMarker, 4);
  if (closingIndex === -1) {
    return { frontmatter: "", body: source };
  }

  const closingLineEnd = source.indexOf("\n", closingIndex + closingMarker.length);
  const frontmatterEnd = closingLineEnd === -1 ? source.length : closingLineEnd + 1;
  return { frontmatter: source.slice(0, frontmatterEnd), body: source.slice(frontmatterEnd) };
}

async function upsertCursorRule(filePath: string, section: string, label: string): Promise<AgentGuidanceResult> {
  const source = await readTextFileIfExists(filePath);
  const next = source === undefined ? cursorRuleContent() : (() => {
    const { frontmatter, body } = splitMarkdownFrontmatter(source);
    const updatedBody = upsertSection(body, section);
    return `${frontmatter}${updatedBody}`;
  })();

  return guidanceResult(label, filePath, await writeTextIfChanged(filePath, next.endsWith("\n") ? next : `${next}\n`, { previous: source }));
}

export function canonicalSkillPath(context: Pick<InitContext, "dataDir">): string {
  return path.join(context.dataDir, "skills", "bitrix-mcp", "SKILL.md");
}

export function claudeSkillPath(context: Pick<InitContext, "projectRoot">): string {
  return path.join(context.projectRoot, ".claude", "skills", "bitrix-mcp", "SKILL.md");
}

async function writeProjectSkill(context: InitContext): Promise<AgentGuidanceResult> {
  return writeTextFile(canonicalSkillPath(context), BITRIX_MCP_SKILL, "canonical skill");
}

function markdownRuleContent(): string {
  return `${markedSection(BITRIX_MCP_RULES)}\n`;
}

function cursorRuleContent(): string {
  return [
    "---",
    "description: Use bitrix-mcp for Bitrix Framework project context, documentation, LiveAPI symbols, templates, and event handlers.",
    "alwaysApply: true",
    "---",
    "",
    markedSection(BITRIX_MCP_RULES),
    ""
  ].join("\n");
}

export type AgentRule = { path: string; mode: "managed" | "cursor"; content: string; label: string; newFileTemplate?: string };

export function agentRulePath(agent: Agent, context: Pick<InitContext, "projectRoot" | "dataDir">): AgentRule {
  const agentLabel = AGENT_CHOICES.find((choice) => choice.id === agent)?.label ?? agent;
  const label = `${agentLabel} guidance`;

  if (agent === "cursor") {
    return { path: path.join(context.projectRoot, ".cursor", "rules", "bitrix-mcp.mdc"), mode: "cursor", content: BITRIX_MCP_RULES, label: "Cursor rules" };
  }
  if (agent === "claude-code") {
    return { path: path.join(context.projectRoot, "CLAUDE.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "vscode") {
    return { path: path.join(context.projectRoot, ".github", "copilot-instructions.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "windsurf") {
    return { path: path.join(context.projectRoot, ".windsurf", "rules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "cline") {
    return { path: path.join(context.projectRoot, ".clinerules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "roo-code") {
    return { path: path.join(context.projectRoot, ".roo", "rules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "continue") {
    return { path: path.join(context.projectRoot, ".continue", "rules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "gemini-cli") {
    return { path: path.join(context.projectRoot, "GEMINI.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "codex") {
    return { path: path.join(context.projectRoot, "AGENTS.md"), mode: "managed", content: BITRIX_MCP_RULES, label: "Codex guidance", newFileTemplate: markdownRuleContent() };
  }
  if (agent === "kilo-code") {
    return { path: path.join(context.projectRoot, ".kilocode", "rules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
  }
  if (agent === "jetbrains") {
    return { path: path.join(context.projectRoot, ".junie", "guidelines.md"), mode: "managed", content: BITRIX_MCP_RULES, label: "JetBrains guidance", newFileTemplate: markdownRuleContent() };
  }
  return { path: path.join(context.dataDir, "rules", "bitrix-mcp.md"), mode: "managed", content: BITRIX_MCP_RULES, label, newFileTemplate: markdownRuleContent() };
}

export interface GuidanceOptions {
  /** Write context-injection hooks for agents that support them (default true). */
  hooks?: boolean;
}

export async function writeAgentGuidance(agent: Agent, context: InitContext, options: GuidanceOptions = {}): Promise<AgentGuidanceResult[]> {
  const results: AgentGuidanceResult[] = [await writeProjectSkill(context)];
  // Claude Code (and Claude Desktop, which reads the same project config) auto-discover
  // skills from <project>/.claude/skills, so install the skill there (the folder is
  // created if missing) in addition to the canonical .bitrix-mcp/skills copy.
  if (agent === "claude-code") {
    results.push(await writeTextFile(claudeSkillPath(context), BITRIX_MCP_SKILL, "Claude skill"));
  }
  const rule = agentRulePath(agent, context);
  results.push(rule.mode === "cursor"
    ? await upsertCursorRule(rule.path, rule.content, rule.label)
    : await upsertMarkedSection(rule.path, rule.content, rule.label, rule.newFileTemplate));
  // Passive rules are not always enough (Claude Code defers MCP tools behind
  // ToolSearch). For agents that support context-injection hooks, also write a
  // hook that actively pushes the "use bitrix-mcp first" directive.
  const hookWriter = HOOK_WRITERS[agent];
  if (hookWriter && options.hooks !== false) {
    results.push(await hookWriter(context));
  }
  return results;
}

/** Env keys bitrix-mcp writes into client configs; any other env key is user-owned. */
export const MANAGED_ENV_KEYS = [
  "BITRIX_MCP_WORKSPACE",
  "BITRIX_MCP_DATA_DIR",
  "BITRIX_MCP_DOCS_DIR",
  "BITRIX_ROOT",
  "BITRIX_MCP_EMBEDDINGS_URL",
  "BITRIX_MCP_SEMANTIC_ENABLED",
  "BITRIX_MCP_OFFICIAL_DOCS_ENABLED",
  "BITRIX_MCP_DB_ENABLED",
  "BITRIX_MCP_DB_ALLOW_WRITE",
  "BITRIX_MCP_TINKER_ENABLED",
  "BITRIX_MCP_PHP_BIN"
];

export function envConfig(context: InitContext): Record<string, string> {
  return {
    BITRIX_MCP_WORKSPACE: context.projectRoot,
    BITRIX_MCP_DATA_DIR: context.dataDir,
    BITRIX_MCP_DOCS_DIR: context.docsDir,
    ...(context.bitrixRoot ? { BITRIX_ROOT: context.bitrixRoot } : {}),
    BITRIX_MCP_EMBEDDINGS_URL: context.embeddingsUrl,
    BITRIX_MCP_SEMANTIC_ENABLED: context.semanticEnabled ? "1" : "0",
    BITRIX_MCP_OFFICIAL_DOCS_ENABLED: "1",
    BITRIX_MCP_DB_ENABLED: context.dbEnabled ? "1" : "0",
    BITRIX_MCP_DB_ALLOW_WRITE: context.dbAllowWrite ? "1" : "0",
    BITRIX_MCP_TINKER_ENABLED: context.tinkerEnabled ? "1" : "0",
    ...(context.tinkerEnabled ? { BITRIX_MCP_PHP_BIN: context.phpBin } : {})
  };
}

/**
 * How MCP clients should spawn the server. On Windows the global install is a
 * set of npm shims (`bitrix-mcp.cmd` / `.ps1`), not a real executable: clients
 * that spawn without a shell cannot resolve the bare `bitrix-mcp` name (ENOENT),
 * and PowerShell additionally prefers the `.ps1` shim, which the default
 * execution policy blocks. Routing through `cmd /c` makes the client launch the
 * policy-immune `.cmd` shim via PATHEXT, so the server starts out of the box.
 */
export function serverInvocation(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "bitrix-mcp", "serve"] }
    : { command: "bitrix-mcp", args: ["serve"] };
}

function mcpServerConfig(context: InitContext): Record<string, unknown> {
  return {
    ...serverInvocation(),
    env: envConfig(context)
  };
}

/** Name of the server entry bitrix-mcp owns inside every client config. */
export const SERVER_ENTRY_NAME = "bitrix-mcp";

export interface ServerEntryOptions {
  /** Top-level object holding servers (`mcpServers`, or `servers` for VS Code). */
  containerKey?: string;
  /** Extra keys always set to our value (e.g. VS Code `type`). */
  managed?: Record<string, unknown>;
  /** Keys set only when missing, so user edits win (e.g. Cline `alwaysAllow`). */
  defaults?: Record<string, unknown>;
}

const CLINE_LIKE_DEFAULTS: ServerEntryOptions = { defaults: { alwaysAllow: [], disabled: false } };

/**
 * Merges the `bitrix-mcp` entry into a JSON/JSONC client config: `command`,
 * `args`, and bitrix-mcp's own env keys are updated, while user-added keys
 * (`disabled`, `timeout`, `alwaysAllow`, extra env vars, ...) plus comments,
 * formatting, and other servers are preserved. Unparsable files abort with an
 * error and are never overwritten; a one-time `<file>.bak` is written before
 * the first change to an existing file.
 */
export async function writeMcpServersConfig(filePath: string, context: InitContext, options: ServerEntryOptions = {}): Promise<WrittenConfig> {
  const containerKey = options.containerKey ?? "mcpServers";
  const doc = await loadJsonConfig(filePath);
  const container = getJsonValue(doc, [containerKey]);
  if (container !== undefined && !isPlainObject(container)) {
    throw new Error(`Cannot update ${filePath}: "${containerKey}" is not an object. bitrix-mcp did not modify it.`);
  }
  const entryPath = [containerKey, SERVER_ENTRY_NAME];
  const existing = getJsonValue(doc, entryPath);
  const managed: Record<string, unknown> = { ...(options.managed ?? {}), ...serverInvocation() };
  const env = envConfig(context);

  if (!isPlainObject(existing)) {
    setJsonValue(doc, entryPath, { ...managed, env, ...(options.defaults ?? {}) });
  } else {
    for (const [key, value] of Object.entries(managed)) {
      setJsonValue(doc, [...entryPath, key], value);
    }
    for (const [key, value] of Object.entries(options.defaults ?? {})) {
      if (!(key in existing)) {
        setJsonValue(doc, [...entryPath, key], value);
      }
    }
    if (!isPlainObject(existing.env)) {
      setJsonValue(doc, [...entryPath, "env"], env);
    } else {
      for (const key of MANAGED_ENV_KEYS) {
        setJsonValue(doc, [...entryPath, "env", key], env[key]);
      }
    }
  }

  const outcome = await saveJsonConfig(doc);
  return { label: filePath, path: filePath, outcome };
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

export const CODEX_TABLE = ["mcp_servers", SERVER_ENTRY_NAME];

function codexTomlBlock(context: InitContext): string {
  const { command, args } = serverInvocation();
  const env = Object.entries(envConfig(context))
    .map(([key, value]) => `${key} = ${escapeTomlString(value)}`)
    .join(", ");
  return [
    "[mcp_servers.bitrix-mcp]",
    `command = ${escapeTomlString(command)}`,
    `args = [${args.map((arg) => escapeTomlString(arg)).join(", ")}]`,
    `env = { ${env} }`
  ].join("\n");
}

/**
 * Replaces the `[mcp_servers.bitrix-mcp]` table in Codex `config.toml`
 * (bare or quoted key, optional trailing comment) and drops stale sub-tables
 * such as `[mcp_servers.bitrix-mcp.env]`; other tables are left untouched.
 */
export function upsertCodexToml(source: string, context: InitContext): string {
  return replaceTomlTable(source, CODEX_TABLE, codexTomlBlock(context));
}

async function writeCodexConfig(filePath: string, context: InitContext): Promise<WrittenConfig> {
  const source = await readTextFileIfExists(filePath);
  const outcome = await writeTextIfChanged(filePath, upsertCodexToml(source ?? "", context), { backup: true, previous: source });
  return { label: "OpenAI Codex", path: filePath, outcome };
}

function homeDirOf(context: Pick<InitContext, "homeDir">): string {
  return context.homeDir ?? resolveHomeDir();
}

export function windsurfConfigPath(context: Pick<InitContext, "homeDir"> = {}): string {
  return path.join(homeDirOf(context), ".codeium", "windsurf", "mcp_config.json");
}

export function clineConfigPath(context: Pick<InitContext, "homeDir"> = {}): string {
  return path.join(homeDirOf(context), ".cline", "data", "settings", "cline_mcp_settings.json");
}

export function codexConfigPath(context: Pick<InitContext, "homeDir"> = {}): string {
  return path.join(homeDirOf(context), ".codex", "config.toml");
}

export function kiloCodeConfigPath(context: Pick<InitContext, "homeDir"> = {}): string {
  return path.join(homeDirOf(context), ".kilocode", "cli", "global", "settings", "mcp_settings.json");
}

/** Where an agent's MCP server config lives (JSON unless `format` says otherwise). */
export interface AgentConfigTarget {
  label: string;
  path: string;
  format: "json" | "toml";
  scope: "project" | "global";
  options?: ServerEntryOptions;
}

export function agentConfigTarget(agent: Agent, context: Pick<InitContext, "projectRoot" | "homeDir">): AgentConfigTarget | undefined {
  const project = (label: string, ...segments: string[]): AgentConfigTarget => ({ label, path: path.join(context.projectRoot, ...segments), format: "json", scope: "project" });
  switch (agent) {
    case "cursor":
      return project("Cursor", ".cursor", "mcp.json");
    case "claude-code":
      return project("Claude Code", ".mcp.json");
    case "vscode":
      return { ...project("VS Code / GitHub Copilot", ".vscode", "mcp.json"), options: { containerKey: "servers", managed: { type: "stdio" } } };
    case "windsurf":
      return { label: "Windsurf", path: windsurfConfigPath(context), format: "json", scope: "global" };
    case "cline":
      return { label: "Cline", path: clineConfigPath(context), format: "json", scope: "global", options: CLINE_LIKE_DEFAULTS };
    case "roo-code":
      return { ...project("Roo Code", ".roo", "mcp.json"), options: CLINE_LIKE_DEFAULTS };
    case "continue":
      return project("Continue", ".continue", "mcpServers", "bitrix-mcp.json");
    case "gemini-cli":
      return project("Gemini CLI", ".gemini", "settings.json");
    case "codex":
      return { label: "OpenAI Codex", path: codexConfigPath(context), format: "toml", scope: "global" };
    case "kilo-code":
      return { label: "Kilo Code", path: kiloCodeConfigPath(context), format: "json", scope: "global", options: CLINE_LIKE_DEFAULTS };
    default:
      return undefined;
  }
}

function jetBrainsSnippet(context: InitContext): string {
  return JSON.stringify({ mcpServers: { "bitrix-mcp": mcpServerConfig(context) } }, null, 2);
}

async function askCustomJsonPath(rl: readline.Interface, context: InitContext): Promise<string> {
  const answer = (await rl.question("Путь к JSON MCP config для другого клиента: ")).trim();
  if (!answer) {
    throw new Error("Custom MCP config path is required for another MCP client.");
  }
  return path.resolve(answer.replace(/^~(?=$|\/|\\)/, homeDirOf(context)));
}

async function writeAgentConfig(agent: Agent, context: InitContext, rl: readline.Interface): Promise<WrittenConfig> {
  const target = agentConfigTarget(agent, context);
  if (target?.format === "toml") {
    return writeCodexConfig(target.path, context);
  }
  if (target) {
    return { ...(await writeMcpServersConfig(target.path, context, target.options)), label: target.label };
  }
  if (agent === "generic-json") {
    const configPath = await askCustomJsonPath(rl, context);
    return { ...(await writeMcpServersConfig(configPath, context)), label: "Другой MCP-клиент" };
  }

  return {
    label: "PhpStorm / JetBrains",
    note: [
      "JetBrains AI Assistant stores MCP servers through the IDE settings UI.",
      "Open Settings | Tools | AI Assistant | Model Context Protocol (MCP), add a STDIO server, and paste:",
      jetBrainsSnippet(context)
    ].join("\n")
  };
}


export function parseAgentSelection(answer: string): Agent[] {
  const tokens = answer
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const selected = tokens.map((token) => AGENT_CHOICES[Number.parseInt(token, 10) - 1]?.id).filter((agent): agent is Agent => Boolean(agent));
  return [...new Set(selected)];
}

async function askAgents(): Promise<{ agents: Agent[]; rl: readline.Interface }> {
  const rl = readline.createInterface({ input, output });
  output.write("Выберите ИИ-агентов для настройки MCP:\n");
  for (const [index, choice] of AGENT_CHOICES.entries()) {
    output.write(`  ${index + 1}. ${choice.label} — ${choice.description}\n`);
  }
  const answer = (await rl.question("Введите один или несколько номеров через запятую [1]: ")).trim() || "1";
  const agents = parseAgentSelection(answer);
  if (agents.length === 0) {
    rl.close();
    throw new Error("Unknown agent choice. Please run init again and choose one or more numbers from the list.");
  }
  return { agents, rl };
}

/**
 * Interactive prompt for project DB access: read access defaults to enabled,
 * write access defaults to disabled. Mirrors `askAgents`' readline usage and
 * reuses the caller's `rl` instance instead of opening a second one.
 */
async function askDbAccess(rl: readline.Interface): Promise<{ dbEnabled: boolean; dbAllowWrite: boolean }> {
  const enableAnswer = (await rl.question("Включить доступ к БД проекта (чтение данных из bitrix/.settings.php)? [Y/n]: ")).trim().toLowerCase();
  const dbEnabled = enableAnswer === "" || ["y", "yes", "да", "д"].includes(enableAnswer);
  if (!dbEnabled) {
    return { dbEnabled: false, dbAllowWrite: false };
  }
  const writeAnswer = (await rl.question("Разрешить запись в БД (INSERT/UPDATE/DELETE)? [y/N]: ")).trim().toLowerCase();
  const dbAllowWrite = ["y", "yes", "да", "д"].includes(writeAnswer);
  return { dbEnabled, dbAllowWrite };
}

/**
 * Interactive prompt for `bitrix_tinker` (arbitrary PHP execution with the
 * Bitrix kernel loaded): defaults to disabled, reusing the caller's `rl`.
 */
async function askTinker(rl: readline.Interface): Promise<boolean> {
  const answer = (await rl.question("Включить bitrix_tinker — выполнение произвольного PHP с ядром Bitrix? ОПАСНО: полный доступ к коду и записи. [y/N]: ")).trim().toLowerCase();
  return ["y", "yes", "да", "д"].includes(answer);
}

const execFileAsync = promisify(execFile);

/**
 * Resolves a command name to an absolute path via the platform PATH lookup
 * (`where` on Windows, `which` elsewhere). Returns undefined when not found.
 */
async function resolveOnPath(command: string): Promise<string | undefined> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, [command]);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the first existing path for a candidate, expanding glob patterns used
 * for versioned install directories and preferring the highest-sorted match.
 */
async function firstExistingPath(candidate: string): Promise<string | undefined> {
  if (candidate.includes("*")) {
    const matches = await fg(candidate, { onlyFiles: true, caseSensitiveMatch: false, suppressErrors: true });
    return matches.length > 0 ? matches.sort().at(-1) : undefined;
  }
  return (await pathExists(candidate)) ? candidate : undefined;
}

/**
 * Detects a PHP CLI binary for `bitrix_tinker`. Honors an explicit
 * BITRIX_MCP_PHP_BIN, then the PATH, then common local dev stacks (Herd,
 * Laragon, XAMPP, OpenServer). Falls back to the bare `php` command.
 */
async function detectPhpBin(): Promise<string> {
  const fromEnv = process.env.BITRIX_MCP_PHP_BIN?.trim();
  if (fromEnv) return fromEnv;

  const pathCandidates = process.platform === "win32" ? ["php.bat", "php.cmd", "php.exe", "php"] : ["php"];
  for (const candidate of pathCandidates) {
    const resolved = await resolveOnPath(candidate);
    if (resolved) return resolved;
  }

  const home = resolveHomeDir().replace(/\\/gu, "/");
  const knownLocations = process.platform === "win32"
    ? [
        `${home}/.config/herd/bin/php.bat`,
        "C:/laragon/bin/php/*/php.exe",
        "C:/xampp/php/php.exe",
        "C:/OSPanel/modules/PHP/*/php.exe",
        "C:/OpenServer/modules/php/*/php.exe"
      ]
    : [
        `${home}/Library/Application Support/Herd/bin/php`,
        "/opt/homebrew/bin/php",
        "/usr/local/bin/php",
        "/usr/bin/php"
      ];
  for (const location of knownLocations) {
    const hit = await firstExistingPath(location);
    if (hit) return hit;
  }

  return "php";
}

/**
 * Interactive confirmation of the PHP CLI path used by `bitrix_tinker`,
 * offering the detected binary as the default.
 */
async function askPhpBin(rl: readline.Interface, detected: string): Promise<string> {
  const answer = (await rl.question(`Путь к PHP CLI для bitrix_tinker [${detected}]: `)).trim();
  return answer || detected;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function parseAgentIds(values: string[]): Agent[] {
  const aliases = new Map<string, Agent>(AGENT_CHOICES.map((choice) => [choice.id, choice.id]));
  aliases.set("claude", "claude-code");
  aliases.set("phpstorm", "jetbrains");
  aliases.set("jetbrains-ai", "jetbrains");
  aliases.set("copilot", "vscode");
  aliases.set("vs-code", "vscode");
  aliases.set("roo", "roo-code");
  aliases.set("gemini", "gemini-cli");
  aliases.set("openai-codex", "codex");
  aliases.set("kilo", "kilo-code");
  aliases.set("other", "generic-json");

  const agents = values
    .flatMap((value) => value.split(/[,\s]+/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => aliases.get(value))
    .filter((agent): agent is Agent => Boolean(agent));
  return [...new Set(agents)];
}

export interface InitOptions {
  agents?: Agent[];
  allAgents?: boolean;
  yes?: boolean;
  index?: boolean;
  docs?: boolean;
  officialDocs?: boolean;
  serve?: boolean;
  db?: boolean;
  dbAllowWrite?: boolean;
  tinker?: boolean;
  phpBin?: string;
  /** Write agent context-injection hooks (default true; `--no-hooks` sets false). */
  hooks?: boolean;
}

export interface InitDependencies {
  serveStdio?: (paths: RuntimePaths) => Promise<void>;
}

export function allConfigurableAgents(): Agent[] {
  return AGENT_CHOICES.map((choice) => choice.id).filter((agent) => agent !== "generic-json");
}

export async function createInitContext(projectRoot = process.cwd()): Promise<InitContext> {
  const dataDir = path.join(projectRoot, ".bitrix-mcp");
  const docsDir = path.join(projectRoot, "docs");
  const embeddingsUrl = process.env.BITRIX_MCP_EMBEDDINGS_URL ?? "http://127.0.0.1:8765";
  const semanticEnabled = isTruthyEnv(process.env.BITRIX_MCP_SEMANTIC_ENABLED);
  const dbEnabled = process.env.BITRIX_MCP_DB_ENABLED === undefined ? true : isTruthyEnv(process.env.BITRIX_MCP_DB_ENABLED);
  const dbAllowWrite = isTruthyEnv(process.env.BITRIX_MCP_DB_ALLOW_WRITE);
  const tinkerEnabled = isTruthyEnv(process.env.BITRIX_MCP_TINKER_ENABLED);
  const phpBin = await detectPhpBin();
  const bitrixRoot = (await pathExists(path.join(projectRoot, "bitrix"))) ? projectRoot : undefined;

  process.env.BITRIX_MCP_DATA_DIR = dataDir;
  process.env.BITRIX_MCP_WORKSPACE = projectRoot;
  process.env.BITRIX_MCP_DOCS_DIR = docsDir;
  if (bitrixRoot) {
    process.env.BITRIX_ROOT = bitrixRoot;
  }

  await fs.mkdir(dataDir, { recursive: true });
  return { projectRoot, dataDir, docsDir, bitrixRoot, embeddingsUrl, semanticEnabled, dbEnabled, dbAllowWrite, tinkerEnabled, phpBin, homeDir: resolveHomeDir() };
}

function runtimePathsFromContext(context: InitContext, officialDocsEnabled: boolean): RuntimePaths {
  return {
    workspaceRoot: context.projectRoot,
    dataDir: context.dataDir,
    docsDir: context.docsDir,
    docsPaths: [context.docsDir],
    bitrixRoot: context.bitrixRoot,
    embeddingsUrl: context.embeddingsUrl,
    semanticEnabled: context.semanticEnabled,
    officialDocsEnabled,
    dbEnabled: context.dbEnabled,
    dbAllowWrite: context.dbAllowWrite,
    tinkerEnabled: context.tinkerEnabled,
    phpBin: context.phpBin
  };
}

async function resolveAgents(options: InitOptions): Promise<{ agents: Agent[]; rl?: readline.Interface }> {
  if (options.allAgents) {
    const agents = allConfigurableAgents();
    output.write(`Configuring all agents: ${agents.join(", ")}\n`);
    return { agents };
  }
  if (options.agents?.length) {
    return { agents: options.agents };
  }
  if (options.yes) {
    output.write("--yes: no --agent given, configuring the default agent: Cursor (cursor). Use --agent <id> or --all-agents to choose others.\n");
    return { agents: ["cursor"] };
  }
  return askAgents();
}

/** Whether init/configure runs interactively, using the same signal as `resolveAgents`. */
function isInteractiveInit(options: InitOptions): boolean {
  return !options.yes && !options.allAgents && !options.agents?.length;
}

/**
 * Resolves project DB access settings: prompts interactively (reusing the
 * shared `rl`) when running interactively, otherwise derives the answer from
 * `InitOptions` (`--no-db` / `--db-allow-write`) without prompting.
 */
async function resolveDbAccess(options: InitOptions, rl?: readline.Interface): Promise<{ dbEnabled: boolean; dbAllowWrite: boolean }> {
  if (isInteractiveInit(options) && rl) {
    return askDbAccess(rl);
  }
  return { dbEnabled: options.db !== false, dbAllowWrite: options.dbAllowWrite === true };
}

/**
 * Resolves `bitrix_tinker` access: prompts interactively (reusing the shared
 * `rl`) when running interactively, otherwise derives the answer from
 * `InitOptions` (`--tinker`) without prompting. Defaults to disabled.
 */
async function resolveTinkerAccess(options: InitOptions, rl?: readline.Interface): Promise<boolean> {
  if (isInteractiveInit(options) && rl) {
    return askTinker(rl);
  }
  return options.tinker === true;
}

export function defaultShouldServe(options: InitOptions): boolean {
  // The MCP config written by init launches `bitrix-mcp serve` from the client,
  // so the client starts the server itself. init therefore does NOT start a
  // (blocking) stdio server by default — only when `--serve` is explicitly passed.
  return options.serve === true;
}

export async function writeConfigs(agents: Agent[], context: InitContext, rl?: readline.Interface): Promise<WrittenConfig[]> {
  const fallbackRl = rl ?? readline.createInterface({ input, output });
  const shouldClose = !rl;
  try {
    const results: WrittenConfig[] = [];
    for (const agent of agents) {
      results.push(await writeAgentConfig(agent, context, fallbackRl));
    }
    return results;
  } finally {
    if (shouldClose) {
      fallbackRl.close();
    }
  }
}

export async function writeGuidance(agents: Agent[], context: InitContext, options: GuidanceOptions = {}): Promise<AgentGuidanceResult[]> {
  const guidanceResults: AgentGuidanceResult[] = [];
  for (const agent of agents) {
    guidanceResults.push(...(await writeAgentGuidance(agent, context, options)));
  }
  return guidanceResults;
}

function printConfigureResults(configResults: WrittenConfig[], guidanceResults: AgentGuidanceResult[]): void {
  for (const configResult of configResults) {
    if (configResult.path) {
      const verb = configResult.outcome === "unchanged" ? "already up to date" : configResult.outcome === "created" ? "created" : "updated";
      output.write(`${configResult.label} MCP config ${verb}: ${configResult.path}\n`);
    }
    if (configResult.note) {
      output.write(`${configResult.label}:\n${configResult.note}\n`);
    }
  }

  output.write("Bitrix MCP guidance installed:\n");
  const uniqueGuidance = new Map<string, string>();
  const warnings: string[] = [];
  for (const result of guidanceResults) {
    if (result.warning) {
      warnings.push(result.warning);
      continue;
    }
    // Preserve the most descriptive label if paths collide (e.g. agent guidance over canonical)
    uniqueGuidance.set(result.path, result.label);
  }
  for (const [filePath, label] of uniqueGuidance.entries()) {
    output.write(`- ${label}: ${filePath}\n`);
  }
  for (const warning of [...new Set(warnings)]) {
    output.write(`Warning: ${warning}\n`);
  }
}

export async function configureAgents(options: InitOptions = {}): Promise<void> {
  const context = await createInitContext();
  const { agents, rl } = await resolveAgents(options);
  try {
    const configResults = await writeConfigs(agents, context, rl);
    const guidanceResults = await writeGuidance(agents, context, { hooks: options.hooks });
    printConfigureResults(configResults, guidanceResults);
  } finally {
    rl?.close();
  }
}

export async function indexIfMissing(paths: RuntimePaths, kind: "project" | "template" | "bitrix", root: string, patterns?: string[], reporter?: ProgressReporter): Promise<void> {
  const dbFile = sqlitePath(paths.dataDir);
  if (await hasIndexMetadata(dbFile, kind)) {
    output.write(`Index ${kind} already exists: ${dbFile}\n`);
    return;
  }
  const manifest = await buildIndex({ root, kind, dbFile, patterns, reporter });
  output.write(`Indexed ${manifest.files.length} ${kind} files into ${dbFile}\n`);
}

export async function indexCode(paths: RuntimePaths, reporter?: ProgressReporter): Promise<void> {
  await indexIfMissing(paths, "project", paths.workspaceRoot, undefined, reporter);
  await indexIfMissing(paths, "template", paths.workspaceRoot, undefined, reporter);
  if (paths.bitrixRoot) {
    await indexIfMissing(paths, "bitrix", paths.bitrixRoot, DEFAULT_BITRIX_PATTERNS, reporter);
  } else {
    output.write("Bitrix root was not detected at <projectRoot>/bitrix; skipping Bitrix index.\n");
  }
}

export async function indexDocs(paths: RuntimePaths): Promise<void> {
  output.write("docs: Indexing documentation (updating sources may take a moment)...\n");
  const docChunks = await indexDocResourcesToSqlite(paths.dataDir, [paths.docsDir], { includeOfficialDocs: paths.officialDocsEnabled });
  output.write(`docs: ✓ Indexed ${docChunks} documentation chunks into ${paths.dataDir}\n`);
}

export async function serve(paths: RuntimePaths, deps: InitDependencies = {}): Promise<void> {
  output.write(
    "\nStarting the bitrix-mcp MCP server over stdio. It will keep running and wait for your MCP client to connect —\n" +
    "this is expected, the process is not frozen. Press Ctrl+C to stop. (Re-run `bitrix-mcp init --no-serve` to skip this step.)\n"
  );
  await (deps.serveStdio ?? serveStdio)(paths);
}

export async function initAndServe(options: InitOptions = {}, deps: InitDependencies = {}): Promise<void> {
  const context = await createInitContext();
  const includeOfficialDocs = options.officialDocs ?? true;

  const { agents, rl } = await resolveAgents(options);
  try {
    const dbAccess = await resolveDbAccess(options, rl);
    context.dbEnabled = dbAccess.dbEnabled;
    context.dbAllowWrite = dbAccess.dbAllowWrite;

    context.tinkerEnabled = await resolveTinkerAccess(options, rl);
    if (context.tinkerEnabled) {
      if (options.phpBin) {
        context.phpBin = options.phpBin;
      } else if (isInteractiveInit(options) && rl) {
        context.phpBin = await askPhpBin(rl, context.phpBin);
      }
    }

    const configResults = await writeConfigs(agents, context, rl);
    const guidanceResults = await writeGuidance(agents, context, { hooks: options.hooks });
    printConfigureResults(configResults, guidanceResults);
  } finally {
    rl?.close();
  }

  const paths = runtimePathsFromContext(context, includeOfficialDocs);

  if (options.index ?? true) {
    const reporter = createProgressReporter({ stderr: process.stderr, isTty: Boolean(process.stderr.isTTY), isCi: detectCi() });
    await indexCode(paths, reporter);
  } else {
    output.write("Skipping code indexing because --no-index was passed.\n");
  }

  if (options.docs ?? true) {
    await indexDocs(paths);
  } else {
    output.write("Skipping documentation indexing because --no-docs was passed.\n");
  }

  if ((options.index ?? true) || (options.docs ?? true)) {
    output.write("\n✓ Bitrix MCP is configured and indexing is complete.\n");
  }

  if (defaultShouldServe(options)) {
    await serve(paths, deps);
  } else {
    output.write("Setup done. Your MCP client will start the server automatically (it runs `bitrix-mcp serve`). Pass --serve to start it now, or run `bitrix-mcp serve` manually.\n");
  }
}
