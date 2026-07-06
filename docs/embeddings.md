# Documentation search & semantic embeddings

Bitrix MCP has two documentation search modes.

1. **Local SQLite FTS (default)** — `bitrix-mcp index-docs` (or `index-all`, or MCP `bitrix_index_docs`) clones/pulls the official Bitrix docs, indexes registered Markdown/text docs into `.bitrix-mcp/bitrix-mcp.sqlite`, and serves `bitrix_docs_search`. No Python needed; network is used only when cloning/pulling Git sources.
2. **Semantic embeddings (optional)** — adds embedding-based ranking via a local Python service. Enable it only when you need that and can run the service alongside the MCP server.

## MCP resources

- `bitrix-docs://index` — JSON list of local documentation resources.
- `bitrix-docs://framework/getting-started.md` — bundled starter reference.

Documentation indexing uses `https://github.com/bitrix-tools/framework-docs.git` plus any local `docs/` directory and registered sources. Drop extra `.md`/`.txt` files under `docs/`, or set `BITRIX_MCP_OFFICIAL_DOCS_ENABLED=0` to skip the official repo.

## Python embeddings service

```bash
cd embeddings
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn service:app --host 127.0.0.1 --port 8765
```

Recommended semantic indexing sequence:

```bash
# 1. Populate SQLite with documentation chunks.
bitrix-mcp index-docs

# 2. Start the embeddings service (separate shell).
cd embeddings
uvicorn service:app --host 127.0.0.1 --port 8765

# 3. Send the SQLite chunks to the service.
bitrix-mcp index-embeddings
# Or combine 1 + 3 when the service is already running:
bitrix-mcp index-docs --embeddings

# 4. Enable the semantic tool before starting the MCP server.
export BITRIX_MCP_SEMANTIC_ENABLED=1
bitrix-mcp serve
```

`bitrix-mcp doctor` checks the service only when `BITRIX_MCP_SEMANTIC_ENABLED=1`. When enabled it also verifies that the service document count matches the current SQLite chunk count; if they differ, rerun `index-embeddings` after `index-docs`.

## Service HTTP API

The service exposes `/health`, `/stats`, `/reload`, `/index`, and `/search`. `/search` keeps the JSON index and embedding matrix in memory after load/reload. You can POST chunks to `/index` manually:

```json
{
  "documents": [
    {
      "id": "framework/events",
      "text": "Bitrix events are registered with AddEventHandler...",
      "metadata": { "uri": "bitrix-docs://framework/events.md" }
    }
  ]
}
```

Search through `/search`, or — when `BITRIX_MCP_SEMANTIC_ENABLED=1` — the MCP tool `bitrix_semantic_docs_search`.
