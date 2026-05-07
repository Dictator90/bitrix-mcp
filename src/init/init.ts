import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { indexPath, type RuntimePaths } from "../config/paths.js";
import { buildIndex } from "../indexer/indexer.js";
import { serveStdio } from "../mcp/server.js";
import { indexDocResourcesToSqlite } from "../resources/docs.js";

type Agent =
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

const AGENT_CHOICES: AgentChoice[] = [
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

interface InitContext {
  projectRoot: string;
  dataDir: string;
  docsDir: string;
  bitrixRoot?: string;
  embeddingsUrl: string;
  semanticEnabled: boolean;
}

interface WrittenConfig {
  label: string;
  path?: string;
  note?: string;
}

interface AgentGuidanceResult {
  label: string;
  path: string;
}

const BITRIX_MCP_SKILL = `---
name: bitrix-mcp
description: Use when working on Bitrix Framework projects with the bitrix-mcp MCP server; searching Bitrix documentation, LiveAPI indexes, event handlers, templates, and project symbols; or deciding when to reindex project/template/Bitrix sources.
---

# Bitrix MCP

Use the configured \`bitrix-mcp\` MCP server as the primary reference source for Bitrix Framework projects.

## Workflow

1. Search project symbols with \`bitrix_liveapi_search\` before editing unfamiliar PHP, JS, template, component, module, or event-handler code.
2. Search documentation with \`bitrix_docs_search\` for Bitrix APIs, framework behavior, and examples. Use \`bitrix_semantic_docs_search\` only when it is available and semantic ranking is useful.
3. Search event handlers with \`bitrix_event_search\` when changing module behavior, component lifecycle code, mail/events, sale/catalog flows, or integration hooks.
4. Check \`bitrix_index_status\` when results look stale. Run \`bitrix_index_project\`, \`bitrix_index_template\`, \`bitrix_index_docs\`, or \`bitrix_index_all\` after relevant files or docs have changed.
5. Prefer project and local documentation evidence over memory. Cite paths, symbols, or documentation resources when explaining Bitrix-specific changes.

## Safety

- Do not edit Bitrix core under \`bitrix/\` unless the user explicitly requests it.
- Prefer extending code under \`local/\`, project templates, or project modules.
- Keep generated indexes and cache files out of application changes unless the user asks to update them.
`;

const BITRIX_MCP_RULES = `# Bitrix MCP rules

- Use the \`bitrix-mcp\` MCP server before making Bitrix-specific assumptions.
- Search LiveAPI/project indexes with \`bitrix_liveapi_search\` before editing unfamiliar symbols, components, templates, modules, or handlers.
- Search Bitrix documentation with \`bitrix_docs_search\`; use \`bitrix_semantic_docs_search\` only when semantic mode is enabled.
- Use \`bitrix_event_search\` for event-driven behavior and module hooks.
- If MCP results look stale, check \`bitrix_index_status\` and reindex with the narrowest relevant tool.
- Do not edit Bitrix core under \`bitrix/\` unless explicitly requested; prefer \`local/\`, project modules, and templates.
`;

const GUIDANCE_SECTION_START = "<!-- bitrix-mcp:init-guidance:start -->";
const GUIDANCE_SECTION_END = "<!-- bitrix-mcp:init-guidance:end -->";

async function writeTextFile(filePath: string, value: string): Promise<AgentGuidanceResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  return { label: "Bitrix MCP guidance", path: filePath };
}

async function upsertMarkedSection(filePath: string, section: string): Promise<AgentGuidanceResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let source = "";
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const normalizedSection = `${GUIDANCE_SECTION_START}\n${section.trim()}\n${GUIDANCE_SECTION_END}`;
  const sectionPattern = new RegExp(`${GUIDANCE_SECTION_START}[\\s\\S]*?${GUIDANCE_SECTION_END}`);
  const next = sectionPattern.test(source)
    ? source.replace(sectionPattern, normalizedSection)
    : `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${normalizedSection}\n`;
  await fs.writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return { label: "Bitrix MCP guidance", path: filePath };
}

async function writeProjectSkill(context: InitContext): Promise<AgentGuidanceResult> {
  return writeTextFile(path.join(context.dataDir, "skills", "bitrix-mcp", "SKILL.md"), BITRIX_MCP_SKILL);
}

function cursorRuleContent(): string {
  return [
    "---",
    "description: Use bitrix-mcp for Bitrix Framework project context, documentation, LiveAPI symbols, templates, and event handlers.",
    "alwaysApply: true",
    "---",
    "",
    BITRIX_MCP_RULES
  ].join("\n");
}

function agentRulePath(agent: Agent, context: InitContext): { path: string; mode: "write" | "append"; content: string } {
  if (agent === "cursor") {
    return { path: path.join(context.projectRoot, ".cursor", "rules", "bitrix-mcp.mdc"), mode: "write", content: cursorRuleContent() };
  }
  if (agent === "claude-code" || agent === "claude-desktop") {
    return { path: path.join(context.projectRoot, "CLAUDE.md"), mode: "append", content: BITRIX_MCP_RULES };
  }
  if (agent === "vscode") {
    return { path: path.join(context.projectRoot, ".github", "copilot-instructions.md"), mode: "append", content: BITRIX_MCP_RULES };
  }
  if (agent === "windsurf") {
    return { path: path.join(context.projectRoot, ".windsurf", "rules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
  }
  if (agent === "cline") {
    return { path: path.join(context.projectRoot, ".clinerules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
  }
  if (agent === "roo-code") {
    return { path: path.join(context.projectRoot, ".roo", "rules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
  }
  if (agent === "continue") {
    return { path: path.join(context.projectRoot, ".continue", "rules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
  }
  if (agent === "gemini-cli") {
    return { path: path.join(context.projectRoot, "GEMINI.md"), mode: "append", content: BITRIX_MCP_RULES };
  }
  if (agent === "codex") {
    return { path: path.join(context.projectRoot, "AGENTS.md"), mode: "append", content: BITRIX_MCP_RULES };
  }
  if (agent === "kilo-code") {
    return { path: path.join(context.projectRoot, ".kilocode", "rules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
  }
  if (agent === "jetbrains") {
    return { path: path.join(context.projectRoot, ".junie", "guidelines.md"), mode: "append", content: BITRIX_MCP_RULES };
  }
  return { path: path.join(context.dataDir, "rules", "bitrix-mcp.md"), mode: "write", content: BITRIX_MCP_RULES };
}

export async function writeAgentGuidance(agent: Agent, context: InitContext): Promise<AgentGuidanceResult[]> {
  const skill = await writeProjectSkill(context);
  const rule = agentRulePath(agent, context);
  const ruleResult = rule.mode === "append" ? await upsertMarkedSection(rule.path, rule.content) : await writeTextFile(rule.path, rule.content);
  return [skill, ruleResult];
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

function parseAgentSelection(answer: string): Agent[] {
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

async function indexIfMissing(paths: RuntimePaths, kind: "project" | "template" | "bitrix", root: string, patterns?: string[]): Promise<void> {
  const outFile = indexPath(paths.dataDir, kind);
  if (await pathExists(outFile)) {
    output.write(`Index ${kind} already exists: ${outFile}\n`);
    return;
  }
  const manifest = await buildIndex({ root, kind, outFile, patterns });
  output.write(`Indexed ${manifest.files.length} ${kind} files into ${outFile}\n`);
}

export async function initAndServe(): Promise<void> {
  const projectRoot = process.cwd();
  const dataDir = path.join(projectRoot, ".bitrix-mcp");
  const docsDir = path.join(projectRoot, "docs");
  const embeddingsUrl = process.env.BITRIX_MCP_EMBEDDINGS_URL ?? "http://127.0.0.1:8765";
  const semanticEnabled = ["1", "true", "yes", "on"].includes((process.env.BITRIX_MCP_SEMANTIC_ENABLED ?? "").trim().toLowerCase());
  const bitrixRoot = (await pathExists(path.join(projectRoot, "bitrix"))) ? projectRoot : undefined;

  process.env.BITRIX_MCP_DATA_DIR = dataDir;
  process.env.BITRIX_MCP_WORKSPACE = projectRoot;
  process.env.BITRIX_MCP_DOCS_DIR = docsDir;
  if (bitrixRoot) {
    process.env.BITRIX_ROOT = bitrixRoot;
  }

  const context: InitContext = { projectRoot, dataDir, docsDir, bitrixRoot, embeddingsUrl, semanticEnabled };
  await fs.mkdir(dataDir, { recursive: true });

  const { agents, rl } = await askAgents();
  try {
    const configResults: WrittenConfig[] = [];
    const guidanceResults: AgentGuidanceResult[] = [];
    for (const agent of agents) {
      configResults.push(await writeAgentConfig(agent, context, rl));
      guidanceResults.push(...(await writeAgentGuidance(agent, context)));
    }

    for (const configResult of configResults) {
      if (configResult.path) {
        output.write(`${configResult.label} MCP config updated: ${configResult.path}\n`);
      }
      if (configResult.note) {
        output.write(`${configResult.label}:\n${configResult.note}\n`);
      }
    }
    const uniqueGuidancePaths = [...new Set(guidanceResults.map((result) => result.path))];
    for (const guidancePath of uniqueGuidancePaths) {
      output.write(`Bitrix MCP guidance updated: ${guidancePath}\n`);
    }
  } finally {
    rl.close();
  }

  const paths: RuntimePaths = { workspaceRoot: projectRoot, dataDir, docsDir, docsPaths: [docsDir], bitrixRoot, embeddingsUrl, semanticEnabled, officialDocsEnabled: true };

  await indexIfMissing(paths, "project", projectRoot);
  await indexIfMissing(paths, "template", projectRoot);
  if (bitrixRoot) {
    await indexIfMissing(paths, "bitrix", bitrixRoot, ["bitrix/modules/**/*.php", "local/modules/**/*.php"]);
  } else {
    output.write("Bitrix root was not detected at <projectRoot>/bitrix; skipping Bitrix index.\n");
  }

  const docChunks = await indexDocResourcesToSqlite(dataDir, [docsDir], { includeOfficialDocs: true });
  output.write(`Indexed ${docChunks} documentation chunks into ${dataDir}\n`);

  output.write("Starting bitrix-mcp over stdio...\n");
  await serveStdio(paths);
}
