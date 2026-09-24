import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { SECRET_FILE_PATTERNS } from "../config/secrets.js";
import { indexPath, resolveBitrixProjectRoot, type RuntimePaths } from "../config/paths.js";
import { DEFAULT_IGNORES, DEFAULT_INDEX_PATTERNS, DEFAULT_INSTALL_ASSET_PATTERNS, type IndexOptions } from "../indexer/indexer.js";
import { resolveBitrixIndex, type BitrixModuleSelection } from "../indexer/bitrixModules.js";
import { resolveTemplateIndexOptions } from "../indexer/template.js";

/** Index scopes a watched change can map to. */
export type WatchScope = "project" | "template" | "bitrix" | "install" | "docs";

export const WATCH_SCOPE_ORDER: WatchScope[] = ["project", "template", "bitrix", "install", "docs"];

export interface WatchScopeOptions {
  /** Skip the Bitrix core and install scopes (`--no-bitrix`). */
  noBitrix?: boolean;
  /** Bitrix core modules to keep indexed (default "all"), as for index-code. */
  modules?: BitrixModuleSelection;
  /** Keep lang/ message files indexed (`--include-lang`). */
  includeLang?: boolean;
  /** Keep module install/ assets indexed (`--install`). */
  includeInstall?: boolean;
  /** Also re-index documentation sources (`--docs`). */
  docs?: boolean;
}

/** One re-index job produced by a batch of file changes. */
export interface ReindexTarget {
  scope: WatchScope;
  /** Deduplication key: the scope name for a whole-scope run, `scope:subPath` otherwise. */
  key: string;
  /** Slash-normalized directory the run is limited to, relative to its scope root; undefined for the whole scope. */
  subPath?: string;
  /** buildIndex options for code scopes; undefined for docs. */
  index?: IndexOptions;
}

/** Everything the indexer accepts, taken from the shared glob `**\/*.{php,js,...}`. */
const CODE_EXTENSIONS = new Set((/\{([^}]+)\}/.exec(DEFAULT_INDEX_PATTERNS[0])?.[1] ?? "php,js").split(",").map((ext) => `.${ext}`));
const DOC_EXTENSIONS = new Set([".md", ".txt"]);
const BITRIX_JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const CODE_GLOB = `**/*.{${[...CODE_EXTENSIONS].map((ext) => ext.slice(1)).join(",")}}`;
const BITRIX_JS_GLOB = `**/*.{${[...BITRIX_JS_EXTENSIONS].map((ext) => ext.slice(1)).join(",")}}`;
// Mirrors the project-kind ignores in src/indexer/indexer.ts: the Bitrix core
// tree and local modules/templates/components/js belong to other scopes.
const PROJECT_EXCLUDED = /^(?:bitrix(?:\/|$)|local\/(?:modules|templates|components|js)(?:\/|$))/u;
const TEMPLATE_AREAS = ["bitrix/templates", "local/templates", "bitrix/components", "local/components"];
const BITRIX_AREAS = ["bitrix/modules", "bitrix/admin", "bitrix/tools", "bitrix/js", "local/modules", "local/js"];
/** Probe child name used to ask "is everything under this directory ignored?". */
const PROBE = "__bitrix_mcp_watch_probe__.php";

function slash(value: string): string {
  return value.replace(/\\/gu, "/");
}

/** Slash-normalized path of `target` relative to `root`, or undefined when outside it. */
export function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return slash(relative);
}

function isUnder(relative: string, prefix: string): boolean {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

function isAncestorOf(relative: string, prefix: string): boolean {
  return relative === "" || prefix.startsWith(`${relative}/`);
}

async function readIgnoreFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Maps changed paths to the index scope (and, where it is cheap to do so, the
 * directory within it) that must be re-indexed, using the same include/ignore
 * rules as discovery: built-in ignores, lang exclusion, the project-kind
 * exclusions, `.gitignore` for project/template, `.bitrixmcpignore` everywhere,
 * the Bitrix core allowlist, and the module selection.
 *
 * Template changes are limited to one site template or component directory,
 * Bitrix core changes to one module (or admin/tools/one js extension), and
 * install changes to one module's install directory; project and docs changes
 * re-run their whole (incremental) scope.
 */
export class WatchScopeMapper {
  readonly workspaceRoot: string;
  readonly bitrixRoot: string | undefined;
  readonly docsRoots: string[];
  private readonly dataDir: string;
  private readonly base: Ignore;
  private workspaceIgnore: Ignore = ignore();
  private bitrixIgnore: Ignore = ignore();

  private constructor(private readonly paths: RuntimePaths, private readonly options: WatchScopeOptions, docsRoots: string[]) {
    this.workspaceRoot = path.resolve(paths.workspaceRoot);
    this.bitrixRoot = paths.bitrixRoot && !options.noBitrix ? resolveBitrixProjectRoot(paths.bitrixRoot) : undefined;
    this.dataDir = path.resolve(paths.dataDir);
    this.docsRoots = options.docs ? docsRoots.map((root) => path.resolve(root)) : [];
    this.base = ignore({ ignorecase: true }).add(SECRET_FILE_PATTERNS).add(DEFAULT_IGNORES).add(options.includeLang ? [] : ["**/lang/**"]);
  }

  static async create(paths: RuntimePaths, options: WatchScopeOptions = {}, docsRoots: string[] = []): Promise<WatchScopeMapper> {
    const mapper = new WatchScopeMapper(paths, options, docsRoots);
    await mapper.reloadIgnoreFiles();
    return mapper;
  }

  /** Re-reads the root `.gitignore` / `.bitrixmcpignore` files. */
  async reloadIgnoreFiles(): Promise<void> {
    this.workspaceIgnore = ignore()
      .add(await readIgnoreFile(path.join(this.workspaceRoot, ".gitignore")))
      .add(await readIgnoreFile(path.join(this.workspaceRoot, ".bitrixmcpignore")));
    this.bitrixIgnore = this.bitrixRoot ? ignore().add(await readIgnoreFile(path.join(this.bitrixRoot, ".bitrixmcpignore"))) : ignore();
  }

  /** Directories to watch: the workspace, an external Bitrix root, and external docs roots. */
  watchRoots(): string[] {
    const roots = [this.workspaceRoot];
    for (const candidate of [...(this.bitrixRoot ? [this.bitrixRoot] : []), ...this.docsRoots]) {
      if (!roots.some((root) => relativeInside(root, candidate) !== undefined)) {
        // A root that contains an existing one replaces it.
        for (let index = roots.length - 1; index >= 0; index -= 1) {
          if (relativeInside(candidate, roots[index]) !== undefined) roots.splice(index, 1);
        }
        roots.push(candidate);
      }
    }
    return roots;
  }

  /** Scopes this watcher can re-index. */
  scopes(): WatchScope[] {
    return WATCH_SCOPE_ORDER.filter((scope) => {
      if (scope === "bitrix") return this.bitrixRoot !== undefined;
      if (scope === "install") return this.bitrixRoot !== undefined && this.options.includeInstall === true;
      if (scope === "docs") return this.docsRoots.length > 0;
      return true;
    });
  }

  /** Whether `absolutePath` is (or is inside) the data directory. */
  isDataPath(absolutePath: string): boolean {
    return relativeInside(this.dataDir, absolutePath) !== undefined;
  }

  /** Whether a directory can hold files of any watched scope (used to prune per-directory watchers). */
  shouldWatchDirectory(absoluteDir: string): boolean {
    if (this.isDataPath(absoluteDir)) return false;
    for (const docsRoot of this.docsRoots) {
      const relative = relativeInside(docsRoot, absoluteDir);
      if (relative !== undefined && !relative.split("/").some((segment) => segment.startsWith("."))) return true;
    }
    const workspaceRelative = relativeInside(this.workspaceRoot, absoluteDir);
    if (workspaceRelative !== undefined) {
      if (workspaceRelative === "") return true;
      const probe = `${workspaceRelative}/${PROBE}`;
      if (!this.base.ignores(probe) && !this.workspaceIgnore.ignores(probe)) {
        if (!PROJECT_EXCLUDED.test(workspaceRelative)) return true;
        if (TEMPLATE_AREAS.some((area) => isUnder(workspaceRelative, area) || isAncestorOf(workspaceRelative, area))) return true;
      }
    }
    if (this.bitrixRoot) {
      const bitrixRelative = relativeInside(this.bitrixRoot, absoluteDir);
      if (bitrixRelative !== undefined) {
        if (bitrixRelative === "") return true;
        const probe = `${bitrixRelative}/${PROBE}`;
        if (this.base.ignores(probe) || this.bitrixIgnore.ignores(probe)) return false;
        if (BITRIX_AREAS.some((area) => isAncestorOf(bitrixRelative, area))) return true;
        const module = /^(bitrix|local)\/modules\/([^/]+)(?:\/(.*))?$/u.exec(bitrixRelative);
        if (module) {
          const inInstall = module[3] !== undefined && isUnder(module[3], "install");
          if (inInstall) return this.options.includeInstall === true && !isUnder(module[3] ?? "", "install/js");
          return this.moduleSelected(module[1], module[2]) || (this.options.includeInstall === true && module[3] === undefined);
        }
        return BITRIX_AREAS.some((area) => isUnder(bitrixRelative, area));
      }
    }
    return false;
  }

  /**
   * Re-index targets for one changed path. `isDirectory` is true for a created,
   * moved or deleted directory: the smallest scope directory containing it is
   * re-indexed (or the whole scope when it contains a scope area).
   */
  classify(absolutePath: string, isDirectory = false): ReindexTarget[] {
    const target = path.resolve(absolutePath);
    if (this.isDataPath(target)) return [];
    const targets: ReindexTarget[] = [];
    const extension = path.extname(target).toLowerCase();

    for (const docsRoot of this.docsRoots) {
      const relative = relativeInside(docsRoot, target);
      if (relative === undefined || relative.split("/").some((segment) => segment.startsWith("."))) continue;
      if (isDirectory || DOC_EXTENSIONS.has(extension)) {
        targets.push({ scope: "docs", key: "docs" });
        break;
      }
    }
    const workspaceRelative = relativeInside(this.workspaceRoot, target);
    const bitrixRelative = this.bitrixRoot ? relativeInside(this.bitrixRoot, target) : undefined;
    const ignoreFileChanged = workspaceRelative === ".gitignore" || workspaceRelative === ".bitrixmcpignore" || bitrixRelative === ".bitrixmcpignore";
    if (!isDirectory && !ignoreFileChanged && !CODE_EXTENSIONS.has(extension)) return targets;

    if (workspaceRelative !== undefined) {
      if (workspaceRelative === ".gitignore" || workspaceRelative === ".bitrixmcpignore") {
        targets.push(this.projectTarget(), this.templateTarget());
      } else if (workspaceRelative !== "") {
        targets.push(...this.workspaceTargets(workspaceRelative, isDirectory));
      } else {
        targets.push(this.projectTarget(), this.templateTarget());
      }
    }

    if (this.bitrixRoot) {
      if (bitrixRelative === ".bitrixmcpignore" || bitrixRelative === "") {
        targets.push(this.bitrixTarget());
        if (this.options.includeInstall) targets.push(this.installTarget());
      } else if (bitrixRelative !== undefined) {
        targets.push(...this.bitrixTargets(bitrixRelative, isDirectory));
      }
    }
    return targets;
  }

  private ignoredEverywhere(relative: string, isDirectory: boolean): boolean {
    return this.base.ignores(isDirectory ? `${relative}/${PROBE}` : relative);
  }

  private workspaceTargets(relative: string, isDirectory: boolean): ReindexTarget[] {
    if (this.ignoredEverywhere(relative, isDirectory)) return [];
    const probe = isDirectory ? `${relative}/${PROBE}` : relative;
    if (this.workspaceIgnore.ignores(probe)) return [];
    const targets: ReindexTarget[] = [];
    if (!PROJECT_EXCLUDED.test(relative)) targets.push(this.projectTarget());

    const siteTemplate = /^((?:bitrix|local)\/templates\/[^/]+)\//u.exec(isDirectory ? `${relative}/` : relative);
    const component = /^((?:bitrix|local)\/components\/[^/]+\/[^/]+)\//u.exec(isDirectory ? `${relative}/` : relative);
    const scoped = siteTemplate?.[1] ?? component?.[1];
    if (scoped) {
      targets.push(this.templateTarget(scoped));
    } else if (TEMPLATE_AREAS.some((area) => isUnder(relative, area) || (isDirectory && isAncestorOf(relative, area)))) {
      targets.push(this.templateTarget());
    }
    return targets;
  }

  private bitrixTargets(relative: string, isDirectory: boolean): ReindexTarget[] {
    if (this.ignoredEverywhere(relative, isDirectory)) return [];
    if (this.bitrixIgnore.ignores(isDirectory ? `${relative}/${PROBE}` : relative)) return [];
    const extension = path.extname(relative).toLowerCase();
    const targets: ReindexTarget[] = [];

    const module = /^(bitrix|local)\/modules\/([^/]+)(?:\/(.*))?$/u.exec(relative);
    if (module && (module[3] !== undefined || isDirectory)) {
      const [, owner, name, rest = ""] = module;
      const moduleDir = `${owner}/modules/${name}`;
      const inInstall = isUnder(rest, "install");
      if (this.options.includeInstall && (inInstall || (isDirectory && rest === "")) && !isUnder(rest, "install/js")) {
        targets.push(this.installTarget(`${moduleDir}/install`));
      }
      if (!inInstall && this.moduleSelected(owner, name) && (isDirectory || extension === ".php")) {
        targets.push(this.bitrixTarget(moduleDir, ["**/*.php"], ["install/**"]));
      }
      return targets;
    }

    const adminOrTools = /^bitrix\/(admin|tools)(?:\/|$)/u.exec(relative);
    if (adminOrTools && (isDirectory || extension === ".php")) {
      return [this.bitrixTarget(`bitrix/${adminOrTools[1]}`, ["**/*.php"])];
    }

    const js = /^(bitrix|local)\/js(?:\/([^/]+)(\/.*)?)?$/u.exec(relative);
    if (js && (isDirectory || BITRIX_JS_EXTENSIONS.has(extension))) {
      const extensionDir = js[2] !== undefined && (js[3] !== undefined || isDirectory) ? `${js[1]}/js/${js[2]}` : `${js[1]}/js`;
      return [this.bitrixTarget(extensionDir, [BITRIX_JS_GLOB])];
    }

    if (isDirectory && BITRIX_AREAS.some((area) => isAncestorOf(relative, area))) {
      targets.push(this.bitrixTarget());
      if (this.options.includeInstall) targets.push(this.installTarget());
    }
    return targets;
  }

  private moduleSelected(owner: string, name: string): boolean {
    const modules = this.options.modules ?? "all";
    return owner === "local" || modules === "all" || modules.includes(name);
  }

  private common(): Pick<IndexOptions, "includeLang" | "retainSymbols"> {
    return { includeLang: this.options.includeLang, retainSymbols: false };
  }

  private projectTarget(): ReindexTarget {
    return {
      scope: "project",
      key: "project",
      index: { root: this.workspaceRoot, kind: "project", outFile: indexPath(this.paths.dataDir, "project"), ...this.common() }
    };
  }

  private templateTarget(subPath?: string): ReindexTarget {
    return {
      scope: "template",
      key: subPath ? `template:${subPath}` : "template",
      subPath,
      index: { ...resolveTemplateIndexOptions(this.paths, subPath), ...this.common() }
    };
  }

  private bitrixTarget(subPath?: string, patterns?: string[], ignores?: string[]): ReindexTarget {
    const root = this.bitrixRoot as string;
    const outFile = indexPath(this.paths.dataDir, "bitrix");
    if (!subPath) {
      const resolved = resolveBitrixIndex({ modules: this.options.modules ?? "all", includeLang: this.options.includeLang });
      return { scope: "bitrix", key: "bitrix", index: { root, kind: "bitrix", outFile, patterns: resolved.patterns, ignores: resolved.ignores, ...this.common() } };
    }
    return {
      scope: "bitrix",
      key: `bitrix:${subPath}`,
      subPath,
      index: { root: path.join(root, subPath), relativeTo: root, kind: "bitrix", outFile, patterns, ignores, ...this.common() }
    };
  }

  private installTarget(subPath?: string): ReindexTarget {
    const root = this.bitrixRoot as string;
    const outFile = indexPath(this.paths.dataDir, "install");
    if (!subPath) {
      return { scope: "install", key: "install", index: { root, kind: "install", outFile, patterns: DEFAULT_INSTALL_ASSET_PATTERNS, ...this.common() } };
    }
    return {
      scope: "install",
      key: `install:${subPath}`,
      subPath,
      // install/js is copied into bitrix/js on install and indexed there.
      index: { root: path.join(root, subPath), relativeTo: root, kind: "install", outFile, patterns: [CODE_GLOB], ignores: ["js/**"], ...this.common() }
    };
  }
}

/**
 * Collapses a batch of targets: a whole-scope run absorbs that scope's
 * directory runs, and a directory run absorbs runs for its subdirectories.
 * Returned in scope order (project, template, bitrix, install, docs).
 */
export function mergeReindexTargets(targets: Iterable<ReindexTarget>): ReindexTarget[] {
  const byKey = new Map<string, ReindexTarget>();
  for (const target of targets) byKey.set(target.key, target);
  const all = [...byKey.values()];
  const kept = all.filter((target) => {
    if (target.subPath === undefined) return true;
    return !all.some((other) => other !== target && other.scope === target.scope && (other.subPath === undefined || isUnder(target.subPath as string, other.subPath)));
  });
  return kept.sort((a, b) => WATCH_SCOPE_ORDER.indexOf(a.scope) - WATCH_SCOPE_ORDER.indexOf(b.scope) || (a.subPath ?? "").localeCompare(b.subPath ?? ""));
}
