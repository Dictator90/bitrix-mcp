# Documentation search & semantic embeddings

Bitrix MCP has two documentation search modes.

1. **Local SQLite FTS (default)** — `bitrix-mcp index-docs` (or `index-all`, or MCP `bitrix_index` with `scope: "docs"`) clones/pulls the official Bitrix docs, indexes registered Markdown/text docs into `.bitrix-mcp/bitrix-mcp.sqlite`, and serves `bitrix_docs_search`. No Python needed; network is used only when cloning/pulling Git sources.
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
python service.py                  # binds 127.0.0.1:8765 by default
# or: uvicorn service:app --host 127.0.0.1 --port 8765
```

The default model is `intfloat/multilingual-e5-small`: it handles Russian and English and reads up to 512 tokens, enough for a whole documentation chunk (the previous default, `paraphrase-multilingual-MiniLM-L12-v2`, silently truncated chunks at 128 tokens). Override it with `BITRIX_MCP_EMBEDDINGS_MODEL` (e5 models get their `query:`/`passage:` prefixes automatically). After changing the model, rerun `bitrix-mcp index-embeddings` — the service refuses to search an index built with a different model.

Service settings:

| Variable | Purpose |
| --- | --- |
| `BITRIX_MCP_EMBEDDINGS_MODEL` | sentence-transformers model (default `intfloat/multilingual-e5-small`). |
| `BITRIX_MCP_EMBEDDINGS_DATA` | Where the index is stored (`docs.meta.json` + `docs.vectors.npy`, written atomically). |
| `BITRIX_MCP_EMBEDDINGS_TOKEN` | Optional shared secret. When set, the service requires `Authorization: Bearer <token>`; set the same variable for `bitrix-mcp` so its client sends it. |
| `BITRIX_MCP_EMBEDDINGS_HOST` / `_PORT` | Bind address for `python service.py` (default `127.0.0.1:8765`). Keep it on loopback unless a token is set: anyone who can reach the port can replace the index. |
| `BITRIX_MCP_EMBEDDINGS_BATCH` | Encoding batch size (default 32). |

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
