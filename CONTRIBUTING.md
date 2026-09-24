# Contributing

Thanks for helping with `bitrix-mcp`. [ARCHITECTURE.md](./ARCHITECTURE.md) explains how the pieces fit together; this page covers setup, tests, and the rules a change has to follow.

## Setup

- **Node.js 22.12 or newer.** The index uses `node:sqlite` (`DatabaseSync`), which Node 20 does not have. CI runs Node 22.12, 22 and 24 on Linux, macOS and Windows.
- Git (used by `detect-changes`, `impact-radius`, and the docs sources).
- Optional: PHP CLI (for `bitrix_tinker` checks), a MySQL/MariaDB instance (for the live DB tests), Python (for the embeddings service in `embeddings/`).

```bash
npm ci
npm run build          # compiles src/ to dist/
node dist/cli.js --help
```

Run the CLI from source without building:

```bash
npx tsx src/cli.ts status
```

To try a change against a real Bitrix project, run `node /path/to/bitrix-mcp/dist/cli.js <command>` from that project's root, or point an MCP client's `command` at it.

## Tests and checks

Every change must pass all three before it is merged; CI runs the same:

```bash
npm run typecheck      # tsc --noEmit over src/, tests/, scripts/
npm test               # node --test with tsx over tests/**/*.test.ts
npm run build
```

Run one file or one test while iterating:

```bash
node --test --import tsx tests/watch.test.ts
node --test --import tsx --test-name-pattern "dry-run" tests/initDryRun.test.ts
```

Tests create their own temporary workspaces (`os.tmpdir()`) and data directories; they must not depend on the machine's home directory or global MCP configs (set `BITRIX_MCP_HOME_DIR` to a temp dir when a test touches global client configs).

### Opt-in tests

These are skipped by `npm test` because they need external services:

| Test | How to run | Needs |
| --- | --- | --- |
| Bitrix core integration (`tests/bitrixCoreRepo.integration.test.ts`) | `npm run test:integration` (sets `BITRIX_MCP_INTEGRATION=1`) | Network, `git`, `tar`, a Unix shell. Clones a pinned revision of a Bitrix core mirror and indexes it end to end. |
| Live MySQL/MariaDB (`tests/db.test.ts`, the `(live)` tests) | `BITRIX_MCP_TEST_MYSQL='{"host":"127.0.0.1","port":3306,"database":"bx","login":"u","password":"p"}' npm run test:mysql` | A reachable database; use a disposable one. |

### Benchmarks

`npm run benchmark` writes `.bitrix-mcp/benchmark.json` and `.bitrix-mcp/benchmark.md` for the current directory. It skips missing optional indexes (no Bitrix root, no docs) with warnings and never forces a full reindex unless you pass `--force`. Include before/after numbers in the pull request when a change is about performance.

## Code conventions

- TypeScript, ES modules, strict mode. Match the style of the surrounding code; keep functions small and documented where the "why" is not obvious.
- User-visible JSON and indexed relative paths are slash-normalized (`/`) on every platform. Do not reintroduce Windows backslashes.
- Keep CLI startup cheap: import heavy modules (MCP SDK, indexer, SQLite store, parsers, `mysql2`) with `await import(...)` where they are used, not at the top of `src/cliMain.ts`.
- Graph code must treat `bitrix_relations` as the only edge table and stay bounded and cycle-safe.
- Verify Bitrix APIs against documentation or the core sources instead of guessing behaviour.
- PHP code follows PSR-12; markup/CSS follows BEM without inline `style` attributes.

## Index format changes

The database migrates itself; users never delete it by hand. Pick the right knob in `src/indexer/store/schema.ts`:

- **`PARSER_VERSION`** — bump when parsing changes *what is extracted* from a file (new symbol kinds, fixed extractor, different relation rows). Every file row stores the version it was parsed with; on the next index run, files with an older version are re-parsed even though their size and mtime are unchanged. No schema change is needed.
- **`SCHEMA_VERSION`** — bump when tables, columns or indexes change. Add the change to `migrateSchema` idempotently (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` check), because it runs on databases of every older version. The migration runs once per database, tracked by `PRAGMA user_version`.
- **FTS layout** — when an FTS table gains or changes columns, extend the outdated-table check in `rebuildOutdatedFtsTables` (`src/indexer/store/fts.ts`) so the table is dropped and refilled from the base tables during migration.

Add a test that opens a database in the old shape (or with old rows) and checks the upgrade, as `tests/searchQuality.test.ts` (FTS upgrade from `user_version` 4) and `tests/storeScope.test.ts` (stale `parser_version`) do.

## Changelog

Every user-visible change gets an entry in [CHANGELOG.md](./CHANGELOG.md) under the upcoming version, in the existing *Fixed / Changed / Added* sections: say what the user sees and what to do, not how the code changed. Internal refactors that change nothing for users need no entry.

## Pull requests

- Branch from `main`; keep a pull request to one topic.
- Describe the user-visible effect and how you tested it (commands, new tests, benchmark numbers).
- Update the docs that describe the behaviour you changed: `docs/cli.md` for commands and flags, `docs/configuration.md` for env vars and `init`, `docs/tools.md` for MCP tools, and the READMEs (English and Russian) when a common workflow changes.

## Releases

Maintainers follow [docs/release.md](./docs/release.md): clean `npm ci`, typecheck, tests, optional integration test, build, `npm pack --dry-run`, version bump in `package.json` and `package-lock.json`, tag `vX.Y.Z`, green CI, then publish.
