# Agent Instructions

- Record every user-visible change in `CHANGELOG.md`; create the file if it does not exist.
- Follow PSR-12 for PHP code.
- Follow BEM for markup/CSS and avoid inline `style` attributes unless unavoidable.
- For Bitrix module/package development, verify Bitrix APIs against documentation or source packages instead of inventing behavior.
- Prefer `rg`/targeted file reads over recursive `ls` or `grep`.
- Run relevant type checks, tests, and builds before finalizing changes when practical.

- For Bitrix dependency graph work, treat `bitrix_relations` as canonical graph edges and keep traversals bounded/cycle-safe.

- Before large Bitrix tasks, use `bitrix_index_status` and `bitrix_project_overview` to understand index freshness, Composer/autoload mappings, discovered entities, and warnings; use `bitrix_detect_changes` for review tasks and graph tools for dependency analysis.
