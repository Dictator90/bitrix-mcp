# Detect changes and review workflow

Workflow: `bitrix_detect_changes` (includes a symbol diff and graph impact by default) → `bitrix_graph_neighbors` or `bitrix_graph_traverse` → `bitrix_relation_search` → `bitrix_read_file_context` or `bitrix_read_symbol_context`.

Example prompt: "Use Bitrix MCP to analyze changes since origin/main."

## Which files count as changed

The tool compares the working tree with `base` (default `HEAD~1`):

- `git diff --name-status --no-renames --relative <base> --` gives modified, added and deleted files. Paths are relative to the workspace root even when it is a subdirectory of the repository. A rename shows up as a deleted file plus an added file.
- `git ls-files --others --exclude-standard` adds untracked, non-ignored files. Only the first 5000 are analyzed, with a warning. Add large untracked trees, such as an unversioned `bitrix/` core, to `.gitignore`.

Each `changedFiles` entry has `file`, `kind` and `status` (`added`, `modified`, `deleted`, `untracked`, `type_changed`, `unmerged`). Kinds are `project`, `template`, `component`, `bitrix`, `install`, `docs`, `asset` and `unknown`. Module installers, including `bitrix/modules/*/install/*`, are `install`, not `bitrix`.

Unsafe base refs are rejected before git is called. If git fails (not a repository, unknown base), the response is still compact and deterministic: no changed files are returned, and `warnings` gives the git error. `bitrix_impact_radius` reports git errors the same way.

## Symbol-level diff

For each changed PHP/JS/TS file, `symbolDiff` compares a "before" symbol set with a fresh parse of the working-tree file:

- `added`: symbols that exist only in the working tree.
- `removed`: symbols that no longer exist.
- `changed`: symbols whose whitespace-normalized signature changed (`reasons: ["signature"]`, before/after signatures included) or whose line span (`lineEnd - line`) changed (`"span"`). A symbol that only moved is not reported.

Symbols are keyed by type and qualified name (`Vendor\Module\Service::resign`; events by `module:event -> handler`; PHP names case-insensitively). Call sites are ignored.

Set the before state with `diffBaseline` (CLI `--diff-baseline`):

- `auto` (default): uses the SQLite index when the file's index row is stale, meaning its size or mtime differs from the working tree or the file was deleted but is still indexed. There the index holds the pre-change state. Otherwise the file is parsed as it was at `base` (`git show <base>:<file>`). Added and untracked files have an empty before state.
- `index`: always uses the indexed symbols.
- `git`: always uses a parse of the file at `base`.

Each file entry names its `baseline` (`index`, `git`, or `none` when neither was available, with a `warning`). `staleIndexFiles` counts the files whose index is older than the working tree. When it is non-zero, the recommendations suggest re-indexing. Disable the diff with `symbolDiff: false` (CLI `--no-symbol-diff`). Files over 2 MB are not re-parsed.

## Deleted files

`deletedFiles` lists every deleted file with the symbols it declared. They come from the index while the file is still indexed (`source: "index"`), or from a parse of the file at `base` (`source: "git"`). Deleted files that declared symbols, removed symbols, and changed signatures raise the risk score. The recommendations then suggest finding callers before merging.

## Other output

`bitrix_detect_changes` also returns the current indexed contents of the changed files: symbols (with `fullyQualifiedName` for methods), events, module usages, agents, mail events, components, ORM entities/usages, IBlock and Highloadblock usages, options, and related relations. It also returns graph impact, merged risk and deterministic recommendations. `summary` counts all of these plus `deletedFiles`, `untrackedFiles`, `symbolsAdded`, `symbolsRemoved` and `symbolsChanged`.

Output is bounded. `maxFiles` (default 200) limits the analyzed files. `maxItems` (default 100) limits each list, and all symbol-diff entries together. `symbolDiff.truncated` is set when entries were dropped. Use `includeImpact: false` (CLI `--no-impact`) when graph traversal is not needed.
