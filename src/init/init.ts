import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { sqlitePath, type RuntimePaths } from "../config/paths.js";
import { buildIndex, DEFAULT_BITRIX_PATTERNS } from "../indexer/indexer.js";
import { hasIndexMetadata } from "../indexer/sqliteStore.js";
import { serveStdio } from "../mcp/server.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";
import { createProgressReporter, detectCi, type ProgressReporter } from "../progress/index.js";

export type Agent =
  | "cursor"
  | "claude-desktop"
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
  { id: "claude-desktop", label: "Claude Desktop", description: "global Claude Desktop config" },
  { id: "claude-code", label: "Claude Code", description: "project config in .mcp.json" },
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
}

export interface WrittenConfig {
  label: string;
  path?: string;
  note?: string;
}

export interface AgentGuidanceResult {
  label: string;
  path: string;
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
Treat \`bitrix-mcp\` tool results as the primary source of truth for Bitrix Framework and project indexed data. Do not manually scan files if MCP returned a successful result unless it is empty, stale, or manual search was explicitly requested.

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

const GUIDANCE_SECTION_START = "<!-- bitrix-mcp:init-guidance:start -->";
const GUIDANCE_SECTION_END = "<!-- bitrix-mcp:init-guidance:end -->";

async function writeTextFile(filePath: string, value: string, label = "Bitrix MCP guidance"): Promise<AgentGuidanceResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  return { label, path: filePath };
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function markedSection(section: string): string {
  return `${GUIDANCE_SECTION_START}\n${section.trim()}\n${GUIDANCE_SECTION_END}`;
}

function upsertSection(source: string, section: string): string {
  const normalizedSection = markedSection(section);
  const sectionPattern = new RegExp(`${GUIDANCE_SECTION_START}[\\s\\S]*?${GUIDANCE_SECTION_END}`);
  return sectionPattern.test(source)
    ? source.replace(sectionPattern, normalizedSection)
    : `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${normalizedSection}\n`;
}

async function upsertMarkedSection(filePath: string, section: string, label: string, newFileTemplate?: string): Promise<AgentGuidanceResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const source = await readTextFileIfExists(filePath);
  const next = source === undefined ? newFileTemplate ?? `${markedSection(section)}\n` : upsertSection(source, section);
  await fs.writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return { label, path: filePath };
}

function splitMarkdownFrontmatter(source: string): { frontmatter: string; body: string } {
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const source = await readTextFileIfExists(filePath);
  const next = source === undefined ? cursorRuleContent() : (() => {
    const { frontmatter, body } = splitMarkdownFrontmatter(source);
    const updatedBody = upsertSection(body, section);
    return `${frontmatter}${updatedBody}`;
  })();

  await fs.writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return { label, path: filePath };
}

async function writeProjectSkill(context: InitContext): Promise<AgentGuidanceResult> {
  return writeTextFile(path.join(context.dataDir, "skills", "bitrix-mcp", "SKILL.md"), BITRIX_MCP_SKILL, "canonical skill");
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

type AgentRule = { path: string; mode: "managed" | "cursor"; content: string; label: string; newFileTemplate?: string };

function agentRulePath(agent: Agent, context: InitContext): AgentRule {
  const agentLabel = AGENT_CHOICES.find((choice) => choice.id === agent)?.label ?? agent;
  const label = `${agentLabel} guidance`;

  if (agent === "cursor") {
    return { path: path.join(context.projectRoot, ".cursor", "rules", "bitrix-mcp.mdc"), mode: "cursor", content: BITRIX_MCP_RULES, label: "Cursor rules" };
  }
  if (agent === "claude-code" || agent === "claude-desktop") {
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

export async function writeAgentGuidance(agent: Agent, context: InitContext): Promise<AgentGuidanceResult[]> {
  const results: AgentGuidanceResult[] = [await writeProjectSkill(context)];
  // Claude Code / Desktop auto-discover skills from <project>/.claude/skills, so
  // install the skill there (the folder is created if missing) in addition to the
  // canonical .bitrix-mcp/skills copy.
  if (agent === "claude-code" || agent === "claude-desktop") {
    results.push(await writeTextFile(
      path.join(context.projectRoot, ".claude", "skills", "bitrix-mcp", "SKILL.md"),
      BITRIX_MCP_SKILL,
      "Claude skill"
    ));
  }
  const rule = agentRulePath(agent, context);
  results.push(rule.mode === "cursor"
    ? await upsertCursorRule(rule.path, rule.content, rule.label)
    : await upsertMarkedSection(rule.path, rule.content, rule.label, rule.newFileTemplate));
  return results;
}


type StdioServerConfig = Record<string, unknown> & {
  command: string;
  args: string[];
  env: Record<string, string>;
};

function stripJsonComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const source = await fs.readFile(filePath, "utf8");
    const trimmed = source.trim();
    if (!trimmed) {
      return {};
    }
    const parsed = JSON.parse(stripJsonComments(trimmed));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`Config ${filePath} must contain a JSON object.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeJsonObject(filePath: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function envConfig(context: InitContext): Record<string, string> {
  return {
    BITRIX_MCP_WORKSPACE: context.projectRoot,
    BITRIX_MCP_DATA_DIR: context.dataDir,
    BITRIX_MCP_DOCS_DIR: context.docsDir,
    ...(context.bitrixRoot ? { BITRIX_ROOT: context.bitrixRoot } : {}),
    BITRIX_MCP_EMBEDDINGS_URL: context.embeddingsUrl,
    BITRIX_MCP_SEMANTIC_ENABLED: context.semanticEnabled ? "1" : "0",
    BITRIX_MCP_OFFICIAL_DOCS_ENABLED: "1"
  };
}

function mcpServerConfig(context: InitContext): StdioServerConfig {
  return {
    command: "bitrix-mcp",
    args: ["serve"],
    env: envConfig(context)
  };
}

function clineLikeServerConfig(context: InitContext): Record<string, unknown> {
  return {
    ...mcpServerConfig(context),
    alwaysAllow: [],
    disabled: false
  };
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export async function writeMcpServersConfig(filePath: string, context: InitContext, serverConfig: Record<string, unknown> = mcpServerConfig(context)): Promise<WrittenConfig> {
  const config = await readJsonObject(filePath);
  ensureObject(config, "mcpServers")["bitrix-mcp"] = serverConfig;
  await writeJsonObject(filePath, config);
  return { label: filePath, path: filePath };
}

async function writeVsCodeConfig(filePath: string, context: InitContext): Promise<WrittenConfig> {
  const config = await readJsonObject(filePath);
  ensureObject(config, "servers")["bitrix-mcp"] = {
    type: "stdio",
    ...mcpServerConfig(context)
  };
  await writeJsonObject(filePath, config);
  return { label: "VS Code / GitHub Copilot", path: filePath };
}

async function writeContinueConfig(filePath: string, context: InitContext): Promise<WrittenConfig> {
  return { ...(await writeMcpServersConfig(filePath, context)), label: "Continue" };
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

function codexTomlBlock(context: InitContext): string {
  const env = Object.entries(envConfig(context))
    .map(([key, value]) => `${key} = ${escapeTomlString(value)}`)
    .join(", ");
  return [
    "[mcp_servers.bitrix-mcp]",
    'command = "bitrix-mcp"',
    'args = ["serve"]',
    `env = { ${env} }`
  ].join("\n");
}

function replaceTomlBlock(source: string, tableName: string, block: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${tableName}]`);
  if (start === -1) {
    return `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) {
    end += 1;
  }
  lines.splice(start, end - start, ...block.split("\n"));
  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeCodexConfig(filePath: string, context: InitContext): Promise<WrittenConfig> {
  let source = "";
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, replaceTomlBlock(source, "mcp_servers.bitrix-mcp", codexTomlBlock(context)), "utf8");
  return { label: "OpenAI Codex", path: filePath };
}

function claudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function windsurfConfigPath(): string {
  return path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
}

function clineConfigPath(): string {
  return path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
}

function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function kiloCodeConfigPath(): string {
  return path.join(os.homedir(), ".kilocode", "cli", "global", "settings", "mcp_settings.json");
}

function jetBrainsSnippet(context: InitContext): string {
  return JSON.stringify({ mcpServers: { "bitrix-mcp": mcpServerConfig(context) } }, null, 2);
}

async function askCustomJsonPath(rl: readline.Interface): Promise<string> {
  const answer = (await rl.question("Путь к JSON MCP config для другого клиента: ")).trim();
  if (!answer) {
    throw new Error("Custom MCP config path is required for another MCP client.");
  }
  return path.resolve(answer.replace(/^~(?=$|\/|\\)/, os.homedir()));
}

async function writeAgentConfig(agent: Agent, context: InitContext, rl: readline.Interface): Promise<WrittenConfig> {
  if (agent === "cursor") {
    return { ...(await writeMcpServersConfig(path.join(context.projectRoot, ".cursor", "mcp.json"), context)), label: "Cursor" };
  }
  if (agent === "claude-desktop") {
    return { ...(await writeMcpServersConfig(claudeDesktopConfigPath(), context)), label: "Claude Desktop" };
  }
  if (agent === "claude-code") {
    return { ...(await writeMcpServersConfig(path.join(context.projectRoot, ".mcp.json"), context)), label: "Claude Code" };
  }
  if (agent === "vscode") {
    return writeVsCodeConfig(path.join(context.projectRoot, ".vscode", "mcp.json"), context);
  }
  if (agent === "windsurf") {
    return { ...(await writeMcpServersConfig(windsurfConfigPath(), context)), label: "Windsurf" };
  }
  if (agent === "cline") {
    return { ...(await writeMcpServersConfig(clineConfigPath(), context, clineLikeServerConfig(context))), label: "Cline" };
  }
  if (agent === "roo-code") {
    return { ...(await writeMcpServersConfig(path.join(context.projectRoot, ".roo", "mcp.json"), context, clineLikeServerConfig(context))), label: "Roo Code" };
  }
  if (agent === "continue") {
    return writeContinueConfig(path.join(context.projectRoot, ".continue", "mcpServers", "bitrix-mcp.json"), context);
  }
  if (agent === "gemini-cli") {
    return { ...(await writeMcpServersConfig(path.join(context.projectRoot, ".gemini", "settings.json"), context)), label: "Gemini CLI" };
  }
  if (agent === "codex") {
    return writeCodexConfig(codexConfigPath(), context);
  }
  if (agent === "kilo-code") {
    return { ...(await writeMcpServersConfig(kiloCodeConfigPath(), context, clineLikeServerConfig(context))), label: "Kilo Code" };
  }
  if (agent === "generic-json") {
    const configPath = await askCustomJsonPath(rl);
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
  const bitrixRoot = (await pathExists(path.join(projectRoot, "bitrix"))) ? projectRoot : undefined;

  process.env.BITRIX_MCP_DATA_DIR = dataDir;
  process.env.BITRIX_MCP_WORKSPACE = projectRoot;
  process.env.BITRIX_MCP_DOCS_DIR = docsDir;
  if (bitrixRoot) {
    process.env.BITRIX_ROOT = bitrixRoot;
  }

  await fs.mkdir(dataDir, { recursive: true });
  return { projectRoot, dataDir, docsDir, bitrixRoot, embeddingsUrl, semanticEnabled };
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
    officialDocsEnabled
  };
}

async function resolveAgents(options: InitOptions): Promise<{ agents: Agent[]; rl?: readline.Interface }> {
  if (options.allAgents) {
    return { agents: allConfigurableAgents() };
  }
  if (options.agents?.length) {
    return { agents: options.agents };
  }
  if (options.yes) {
    return { agents: ["cursor"] };
  }
  return askAgents();
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

export async function writeGuidance(agents: Agent[], context: InitContext): Promise<AgentGuidanceResult[]> {
  const guidanceResults: AgentGuidanceResult[] = [];
  for (const agent of agents) {
    guidanceResults.push(...(await writeAgentGuidance(agent, context)));
  }
  return guidanceResults;
}

function printConfigureResults(configResults: WrittenConfig[], guidanceResults: AgentGuidanceResult[]): void {
  for (const configResult of configResults) {
    if (configResult.path) {
      output.write(`${configResult.label} MCP config updated: ${configResult.path}\n`);
    }
    if (configResult.note) {
      output.write(`${configResult.label}:\n${configResult.note}\n`);
    }
  }

  output.write("Bitrix MCP guidance installed:\n");
  const uniqueGuidance = new Map<string, string>();
  for (const result of guidanceResults) {
    // Preserve the most descriptive label if paths collide (e.g. agent guidance over canonical)
    uniqueGuidance.set(result.path, result.label);
  }
  for (const [filePath, label] of uniqueGuidance.entries()) {
    output.write(`- ${label}: ${filePath}\n`);
  }
}

export async function configureAgents(options: InitOptions = {}): Promise<void> {
  const context = await createInitContext();
  const { agents, rl } = await resolveAgents(options);
  try {
    const configResults = await writeConfigs(agents, context, rl);
    const guidanceResults = await writeGuidance(agents, context);
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
  const paths = runtimePathsFromContext(context, includeOfficialDocs);

  const { agents, rl } = await resolveAgents(options);
  try {
    const configResults = await writeConfigs(agents, context, rl);
    const guidanceResults = await writeGuidance(agents, context);
    printConfigureResults(configResults, guidanceResults);
  } finally {
    rl?.close();
  }

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
