# Bitrix MCP Project Context

## Project Overview
Bitrix MCP is a specialized Model Context Protocol (MCP) server designed for **Bitrix Framework / 1C-Bitrix** development. It provides deep project indexing, LiveAPI search, and documentation retrieval without requiring a running Bitrix instance or authentication.

### Core Technologies
- **Runtime:** Node.js (>= 22.12.0) utilizing `node:sqlite`.
- **Protocol:** Model Context Protocol (MCP) via `@modelcontextprotocol/sdk`.
- **Parsing:** `php-parser` for PHP symbols and `fast-glob` for file discovery.
- **Search:** SQLite FTS5 for documentation and structured queries for code symbols.
- **Optional:** Python (FastAPI + `sentence-transformers`) for semantic documentation search.

### Architecture
The project follows a modular structure:
- `src/cli.ts`: Entry point for the CLI tool.
- `src/mcp/server.ts`: Implementation of the MCP server and tool definitions.
- `src/indexer/`: Core logic for indexing various Bitrix-specific entities (LiveAPI, templates, ORM, events).
- `src/resources/`: Management of documentation resources.
- `src/liveapi/`: Specialized parsers for PHP and JS Bitrix symbols.
- `embeddings/`: Python service for semantic search capabilities.

## Building and Running

### Development Commands
- **Install dependencies:** `npm install`
- **Build project:** `npm run build` (transpiles TypeScript to `dist/`)
- **Run tests:** `npm test` (uses Node's native test runner)
- **Typecheck:** `npm run typecheck`
- **Run CLI locally:** `node dist/cli.js <command>` or `tsx src/cli.ts <command>`
- **Start MCP server:** `npm start` (runs `node dist/cli.js serve`)
- **Benchmark:** `npm run benchmark`

### CLI Tool (`bitrix-mcp`)
Common commands for indexing and diagnostics:
- `bitrix-mcp init`: Interactive setup for MCP clients.
- `bitrix-mcp index-all`: Performs a full index of the project, core, and docs.
- `bitrix-mcp status`: Checks index health and record counts.
- `bitrix-mcp doctor`: Runs comprehensive environment diagnostics.

## Development Conventions

### Indexing Kinds
The project categorizes indexed data into four primary "kinds":
1.  `project`: Local code (excluding modules and templates).
2.  `template`: Bitrix templates and components.
3.  `bitrix`: Bitrix Framework core modules.
4.  `install`: Asset files within module `install/` directories.

### Coding Standards
- **ES Modules:** The project uses native ES modules (`"type": "module"`).
- **TypeScript:** Strict typing is enforced. Use `npm run typecheck` before committing.
- **Surgical Updates:** When modifying the indexer or MCP tools, ensure that the SQLite schema and Zod schemas in `src/mcp/server.ts` are kept in sync.
- **Path Handling:** Always use `resolveRuntimePaths` from `src/config/paths.js` to ensure consistency across different environments and MCP clients.

### Testing
- Integration tests are located in `tests/`.
- Use `tests/fixtures/project` for testing indexing logic on a mock Bitrix structure.
- New features or bug fixes should always include a corresponding test in `tests/`.

## Key Files & Directories
- `src/types.ts`: Central repository for all shared interfaces and types.
- `src/indexer/sqliteStore.ts`: Handles all SQLite interactions and complex search queries.
- `docs/`: Comprehensive technical documentation for various features (Graph, ORM, Indexing, etc.).
- `AGENTS.md`: Registry of supported AI agents and their configuration status.
