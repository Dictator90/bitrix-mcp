# Agent Instructions

- Record every user-visible change in `CHANGELOG.md`; create the file if it does not exist.
- Follow PSR-12 for PHP code.
- Follow BEM for markup/CSS and avoid inline `style` attributes unless unavoidable.
- For Bitrix module/package development, verify Bitrix APIs against documentation or source packages instead of inventing behavior.
- Prefer `rg`/targeted file reads over recursive `ls` or `grep`.
- Run relevant type checks, tests, and builds before finalizing changes when practical.
