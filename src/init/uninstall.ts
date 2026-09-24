import fs from "node:fs/promises";
import path from "node:path";
import { resolveHomeDir } from "../config/home.js";
import {
  getJsonValue,
  isEffectivelyEmpty,
  isPlainObject,
  loadJsonConfig,
  readTextFileIfExists,
  replaceTomlTable,
  saveJsonConfig,
  setJsonValue,
  hasTomlTable,
  writeTextIfChanged,
  type JsonConfigDocument
} from "./configFiles.js";
import {
  AGENT_CHOICES,
  BITRIX_MCP_HOOK_MARKER,
  CODEX_TABLE,
  GUIDANCE_SECTION_PATTERN,
  SERVER_ENTRY_NAME,
  agentConfigTarget,
  agentRulePath,
  canonicalSkillPath,
  claudeSettingsPath,
  claudeSkillPath,
  clineHookPath,
  codexHooksPath,
  copilotHooksPath,
  cursorHooksPath,
  geminiSettingsPath,
  removeManagedHooks,
  splitMarkdownFrontmatter,
  type Agent
} from "./init.js";

export interface UninstallOptions {
  /** Agents to uninstall; all agents when omitted. */
  agents?: Agent[];
  allAgents?: boolean;
  /** Only report what would change. */
  dryRun?: boolean;
  projectRoot?: string;
  dataDir?: string;
  homeDir?: string;
}

export interface UninstallAction {
  action: "update" | "delete" | "skip" | "note";
  path?: string;
  description: string;
}

interface UninstallContext {
  projectRoot: string;
  dataDir: string;
  homeDir: string;
}

/**
 * Collects JSON edits per file so a file shared by several steps (e.g.
 * `.gemini/settings.json`: MCP server + hooks) is written once.
 */
class JsonEdits {
  private readonly docs = new Map<string, { doc: JsonConfigDocument; descriptions: string[]; ignoreKeys: string[] }>();

  async load(filePath: string, actions: UninstallAction[]): Promise<JsonConfigDocument | undefined> {
    const cached = this.docs.get(filePath);
    if (cached) return cached.doc;
    if ((await readTextFileIfExists(filePath)) === undefined) return undefined;
    try {
      const doc = await loadJsonConfig(filePath);
      this.docs.set(filePath, { doc, descriptions: [], ignoreKeys: [] });
      return doc;
    } catch (error) {
      actions.push({ action: "skip", path: filePath, description: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  record(filePath: string, description: string, ignoreKeys: string[] = []): void {
    const entry = this.docs.get(filePath);
    if (!entry) return;
    entry.descriptions.push(description);
    entry.ignoreKeys.push(...ignoreKeys);
  }

  plan(): Array<{ doc: JsonConfigDocument; description: string; remove: boolean }> {
    return [...this.docs.values()]
      .filter((entry) => entry.descriptions.length > 0)
      .map(({ doc, descriptions, ignoreKeys }) => {
        const rest = Object.fromEntries(Object.entries(doc.value).filter(([key]) => !ignoreKeys.includes(key)));
        return { doc, description: descriptions.join("; "), remove: isEffectivelyEmpty(rest) };
      });
  }
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Removes now-empty parent directories of a deleted file, never leaving `root`. */
async function removeEmptyParents(filePath: string, root: string): Promise<void> {
  let dir = path.dirname(filePath);
  while (isInside(root, dir)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function removeServerEntry(doc: JsonConfigDocument, containerKey: string): boolean {
  const container = getJsonValue(doc, [containerKey]);
  if (!isPlainObject(container) || !(SERVER_ENTRY_NAME in container)) {
    return false;
  }
  setJsonValue(doc, [containerKey, SERVER_ENTRY_NAME], undefined);
  const after = getJsonValue(doc, [containerKey]);
  if (isPlainObject(after) && Object.keys(after).length === 0) {
    setJsonValue(doc, [containerKey], undefined);
  }
  return true;
}

function removeAllManagedHooks(doc: JsonConfigDocument): boolean {
  const hooks = getJsonValue(doc, ["hooks"]);
  if (!isPlainObject(hooks)) return false;
  let removed = false;
  for (const event of Object.keys(hooks)) {
    removed = removeManagedHooks(doc, event) || removed;
  }
  const after = getJsonValue(doc, ["hooks"]);
  if (removed && isPlainObject(after) && Object.keys(after).length === 0) {
    setJsonValue(doc, ["hooks"], undefined);
  }
  return removed;
}

function workspaceOf(entry: unknown): string | undefined {
  if (!isPlainObject(entry) || !isPlainObject(entry.env)) return undefined;
  const workspace = entry.env.BITRIX_MCP_WORKSPACE;
  return typeof workspace === "string" ? workspace : undefined;
}

function sameWorkspace(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function codexWorkspace(source: string): string | undefined {
  const match = /BITRIX_MCP_WORKSPACE\s*=\s*("(?:[^"\\]|\\.)*")/.exec(source);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

function withoutGuidanceSection(source: string): string {
  return source.replace(new RegExp(`\\n*${GUIDANCE_SECTION_PATTERN.source}\\n*`), "\n\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

async function planTextFileChange(
  filePath: string,
  compute: (source: string) => { next?: string; remove?: boolean; description: string } | undefined,
  actions: UninstallAction[],
  applies: Array<() => Promise<void>>,
  cleanupRoot: string | undefined
): Promise<void> {
  const source = await readTextFileIfExists(filePath);
  if (source === undefined) return;
  const change = compute(source);
  if (!change) return;
  if (change.remove) {
    actions.push({ action: "delete", path: filePath, description: change.description });
    applies.push(async () => {
      await fs.rm(filePath, { force: true });
      if (cleanupRoot) await removeEmptyParents(filePath, cleanupRoot);
    });
  } else if (change.next !== undefined && change.next !== source) {
    const next = change.next;
    actions.push({ action: "update", path: filePath, description: change.description });
    applies.push(async () => {
      await writeTextIfChanged(filePath, next, { previous: source });
    });
  }
}

/**
 * Removes everything `init`/`configure` wrote, identified by bitrix-mcp's
 * markers: the `bitrix-mcp` server entry in client configs, managed hooks,
 * managed guidance sections, and installed skill files. User content in the
 * same files is preserved; files left empty are deleted. Global configs are
 * only touched when their entry points at this project. Index data in the
 * data directory is kept.
 */
export async function uninstall(options: UninstallOptions = {}): Promise<UninstallAction[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const context: UninstallContext = {
    projectRoot,
    dataDir: options.dataDir ?? path.join(projectRoot, ".bitrix-mcp"),
    homeDir: options.homeDir ?? resolveHomeDir()
  };
  const everything = options.allAgents || !options.agents?.length;
  const agents: Agent[] = everything ? AGENT_CHOICES.map((choice) => choice.id) : options.agents ?? [];

  const actions: UninstallAction[] = [];
  const applies: Array<() => Promise<void>> = [];
  const json = new JsonEdits();

  for (const agent of agents) {
    // 1. MCP server entry.
    const target = agentConfigTarget(agent, context);
    if (target?.format === "toml") {
      const source = await readTextFileIfExists(target.path);
      if (source !== undefined && hasTomlTable(source, CODEX_TABLE)) {
        const workspace = codexWorkspace(source);
        if (workspace && !sameWorkspace(workspace, projectRoot)) {
          actions.push({ action: "skip", path: target.path, description: `${target.label}: bitrix-mcp entry belongs to another workspace (${workspace})` });
        } else {
          const next = replaceTomlTable(source, CODEX_TABLE, undefined);
          actions.push({ action: "update", path: target.path, description: `${target.label}: remove [mcp_servers.bitrix-mcp]` });
          applies.push(async () => {
            await writeTextIfChanged(target.path, next, { backup: true, previous: source });
          });
        }
      }
    } else if (target) {
      const doc = await json.load(target.path, actions);
      const containerKey = target.options?.containerKey ?? "mcpServers";
      if (doc) {
        const workspace = workspaceOf(getJsonValue(doc, [containerKey, SERVER_ENTRY_NAME]));
        if (target.scope === "global" && workspace && !sameWorkspace(workspace, projectRoot)) {
          actions.push({ action: "skip", path: target.path, description: `${target.label}: bitrix-mcp entry belongs to another workspace (${workspace})` });
        } else if (removeServerEntry(doc, containerKey)) {
          json.record(target.path, `${target.label}: remove ${containerKey}.${SERVER_ENTRY_NAME}`);
        }
      }
    } else if (agent === "generic-json") {
      actions.push({ action: "note", description: "Custom MCP client (generic-json): its config path is not recorded; remove the \"bitrix-mcp\" entry manually if you added one." });
    } else if (agent === "jetbrains") {
      actions.push({ action: "note", description: "PhpStorm / JetBrains: remove the bitrix-mcp server in Settings | Tools | AI Assistant | Model Context Protocol (MCP)." });
    }

    // 2. Managed guidance section in the agent's rule file.
    const rule = agentRulePath(agent, context);
    await planTextFileChange(rule.path, (source) => {
      if (!GUIDANCE_SECTION_PATTERN.test(source)) return undefined;
      if (rule.mode === "cursor") {
        const { frontmatter, body } = splitMarkdownFrontmatter(source);
        const rest = withoutGuidanceSection(body);
        return rest.trim() ? { next: `${frontmatter}${rest.trimEnd()}\n`, description: `${rule.label}: remove managed section` } : { remove: true, description: `${rule.label}: only bitrix-mcp content` };
      }
      const rest = withoutGuidanceSection(source);
      return rest.trim() ? { next: `${rest.trimEnd()}\n`, description: `${rule.label}: remove managed section` } : { remove: true, description: `${rule.label}: only bitrix-mcp content` };
    }, actions, applies, projectRoot);

    // 3. Managed hooks.
    const hookJsonFiles: Array<{ path: string; label: string; ignoreKeys?: string[] }> = [];
    if (agent === "claude-code") hookJsonFiles.push({ path: claudeSettingsPath(context), label: "Claude Code hooks" });
    if (agent === "gemini-cli") hookJsonFiles.push({ path: geminiSettingsPath(context), label: "Gemini CLI hooks" });
    if (agent === "cursor") hookJsonFiles.push({ path: cursorHooksPath(context), label: "Cursor hooks", ignoreKeys: ["version"] });
    if (agent === "codex") hookJsonFiles.push({ path: codexHooksPath(context), label: "Codex hooks" });
    for (const hookFile of hookJsonFiles) {
      const doc = await json.load(hookFile.path, actions);
      if (doc && removeAllManagedHooks(doc)) {
        json.record(hookFile.path, `${hookFile.label}: remove managed hooks`, hookFile.ignoreKeys);
      }
    }
    const ownedHookFiles: Array<{ path: string; label: string }> = [];
    if (agent === "vscode") ownedHookFiles.push({ path: copilotHooksPath(context), label: "Copilot hooks" });
    if (agent === "cline") ownedHookFiles.push({ path: clineHookPath(context), label: "Cline hooks" });
    for (const hookFile of ownedHookFiles) {
      await planTextFileChange(hookFile.path, (source) => source.includes(BITRIX_MCP_HOOK_MARKER)
        ? { remove: true, description: hookFile.label }
        : undefined, actions, applies, projectRoot);
    }

    // 4. Skills.
    if (agent === "claude-code") {
      await planTextFileChange(claudeSkillPath(context), (source) => isOurSkill(source) ? { remove: true, description: "Claude skill" } : undefined, actions, applies, projectRoot);
    }
  }

  if (everything) {
    await planTextFileChange(canonicalSkillPath(context), (source) => isOurSkill(source) ? { remove: true, description: "canonical skill" } : undefined, actions, applies, context.dataDir);
  }

  for (const { doc, description, remove } of json.plan()) {
    const cleanupRoot = isInside(projectRoot, doc.filePath) ? projectRoot : undefined;
    if (remove) {
      actions.push({ action: "delete", path: doc.filePath, description: `${description} (nothing else left)` });
      applies.push(async () => {
        await fs.rm(doc.filePath, { force: true });
        if (cleanupRoot) await removeEmptyParents(doc.filePath, cleanupRoot);
      });
    } else {
      actions.push({ action: "update", path: doc.filePath, description });
      applies.push(async () => {
        await saveJsonConfig(doc);
      });
    }
  }

  if (!options.dryRun) {
    for (const apply of applies) {
      await apply();
    }
  }
  return actions;
}

function isOurSkill(source: string): boolean {
  return /^---\r?\nname: bitrix-mcp\r?\n/.test(source);
}

export function formatUninstallActions(actions: UninstallAction[], dryRun: boolean): string {
  const lines: string[] = [];
  const changes = actions.filter((entry) => entry.action === "update" || entry.action === "delete");
  if (changes.length === 0) {
    lines.push("Nothing to uninstall: no bitrix-mcp configuration was found.");
  } else {
    lines.push(dryRun ? "Dry run — these changes would be made:" : "Removed bitrix-mcp configuration:");
    for (const entry of changes) {
      const verb = entry.action === "delete" ? (dryRun ? "delete" : "deleted") : (dryRun ? "update" : "updated");
      lines.push(`- ${verb} ${entry.path}: ${entry.description}`);
    }
  }
  for (const entry of actions.filter((item) => item.action === "skip")) {
    lines.push(`Skipped ${entry.path}: ${entry.description}`);
  }
  for (const entry of actions.filter((item) => item.action === "note")) {
    lines.push(`Note: ${entry.description}`);
  }
  if (!dryRun && changes.length > 0) {
    lines.push("Index data in .bitrix-mcp and any *.bak backups were kept; delete them manually if no longer needed.");
  }
  return lines.join("\n");
}

export async function runUninstall(options: UninstallOptions = {}): Promise<void> {
  const actions = await uninstall(options);
  console.log(formatUninstallActions(actions, options.dryRun === true));
}
