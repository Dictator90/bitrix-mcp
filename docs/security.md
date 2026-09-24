# Security and local data

Bitrix MCP is local and token-free. It indexes files from configured local roots into `.bitrix-mcp/bitrix-mcp.sqlite`; keep that directory private if source paths or snippets are sensitive. File-context reads are restricted to the workspace and data directory. Project/template indexing through MCP rejects paths outside the workspace unless `BITRIX_MCP_ALLOW_OUTSIDE_WORKSPACE=1` is explicitly set. Built-in indexing ignores skip heavy or generated trees including `node_modules/`, `vendor/`, `upload/`, `cache/`, and `generated/`.

Documentation Git sources may require network during `index-docs`/`index-all` when official docs are enabled. Benchmark reporting writes JSON/Markdown reports but never deletes user data.

## Database tools

Live project database access is off in the server by default: the DB tools are registered only when `BITRIX_MCP_DB_ENABLED=1`. Note that `init` asks whether to enable it and defaults to **yes**, writing `BITRIX_MCP_DB_ENABLED=1` into the generated MCP config; answer no or pass `--no-db` to keep it off.

`bitrix_db_query` is read-only in three layers:

1. **Statement filter.** A string- and comment-aware lexer accepts a single `SELECT`/`SHOW`/`EXPLAIN`/`DESCRIBE`/`WITH` statement and rejects write, lock and file keywords anywhere in it (`WITH … DELETE`, `INTO OUTFILE`/`DUMPFILE`, `FOR UPDATE`, `LOCK IN SHARE MODE`, …), executable comments (`/*! … */`), and side-effecting functions (`LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `NEXTVAL`, …).
2. **Read-only transaction.** The statement runs inside `START TRANSACTION READ ONLY … ROLLBACK`, so table writes fail even if something slips past the filter.
3. **Resource limits.** A server-side statement timeout (`max_statement_time` on MariaDB, `MAX_EXECUTION_TIME` on MySQL) plus a client timeout that issues `KILL QUERY`; results are streamed and capped by rows (`limit`, default 500) and size (about 1 MB).

These layers still run with the privileges of the connection. Stored functions or procedures you call can have side effects, and the account can read every table it is granted. For a guarantee, create a database account with only `SELECT` (and no `FILE` privilege) and set `BITRIX_MCP_DB_READONLY_USER` / `BITRIX_MCP_DB_READONLY_PASSWORD`; `bitrix_db_query` and `bitrix_db_schema` then use it instead of the `.settings.php` credentials. `BITRIX_MCP_DB_ALLOW_WRITE=1` additionally registers `bitrix_db_execute` for arbitrary write SQL, which always uses the `.settings.php` account.

## Secrets

Credentials are read from `bitrix/.settings.php` (merged with `.settings_extra.php`). `bitrix_db_connections` redacts the password (it reports only whether one is set).

`bitrix_read_file_context` and `bitrix_read_symbol_context` refuse files that typically hold credentials or bulk data, and indexing skips them: `.settings.php`, `.settings_extra.php`, `php_interface/dbconn.php`, `bitrix/license_key.php`, `.env` and `.env.*`, `.git/`/`.svn/`/`.hg/`, `.ssh/`, `.htpasswd`, `.npmrc`, `auth.json`, private keys and certificates (`*.pem`, `*.key`, `id_rsa*`, …), SQL dumps, SQLite files, and `bitrix/backup/`. Set `BITRIX_MCP_ALLOW_SECRET_FILES=1` to lift this on a trusted machine. Context reads also refuse binary files and files over 10 MB.

Secrets can still reach the AI client through the data itself: `bitrix_db_query` can read `b_user` password hashes and secrets stored in `b_option`, and `bitrix_tinker` can read anything the PHP process can. Treat everything the enabled tools can reach as visible to the client. These features are intended for a local development database on the same machine, never production data. Tool results can also carry text written by site visitors (for example iblock element texts); an AI client may follow instructions hidden in such data, which is one more reason to keep `bitrix_tinker` and `bitrix_db_execute` off unless you need them.

## Runtime PHP (`bitrix_tinker`)

The `bitrix_tinker` tool executes arbitrary PHP with the Bitrix kernel loaded and is the most powerful capability in the server: it can run any code and modify any data, and it bypasses the read-only restrictions of `bitrix_db_query` entirely. It is off by default and only registered when `BITRIX_MCP_TINKER_ENABLED=1`. Enable it only on a trusted local development machine — never against shared or production environments. `BITRIX_MCP_PHP_BIN` should point at a PHP CLI matching the site's PHP version and extensions.

Safeguards: PHP runs with a minimal environment (PATH, HOME, locale, temp and PHP ini variables, and Windows system variables), so API tokens and cloud credentials in the MCP client's environment are not visible to it; add variables with `BITRIX_MCP_TINKER_ENV_PASSTHROUGH=VAR1,VAR2`. Output is capped (the process is killed above 4 MB), and a timeout kills the whole process tree. It still runs as your OS user, with that user's files and network access.

## Confirmation and annotations

Every tool carries MCP annotations: searches and reads are `readOnlyHint`, index tools write only the local index, and `bitrix_db_execute` / `bitrix_tinker` are `destructiveHint`, so clients that honour annotations ask before running them. When the client supports MCP elicitation, those two tools also ask you to approve each call with the SQL or PHP shown; set `BITRIX_MCP_CONFIRM_DANGEROUS=0` to skip that prompt.
