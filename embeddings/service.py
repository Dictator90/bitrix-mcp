from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# multilingual-e5 handles Russian and English and reads up to 512 tokens, enough for a whole
# documentation chunk (the previous MiniLM default truncated chunks at 128 tokens).
MODEL_NAME = os.getenv("BITRIX_MCP_EMBEDDINGS_MODEL", "intfloat/multilingual-e5-small")
DATA_DIR = Path(os.getenv("BITRIX_MCP_EMBEDDINGS_DATA", ".bitrix-mcp/embeddings"))
TOKEN = os.getenv("BITRIX_MCP_EMBEDDINGS_TOKEN", "")
BATCH_SIZE = int(os.getenv("BITRIX_MCP_EMBEDDINGS_BATCH", "32"))
MAX_DOCUMENTS = int(os.getenv("BITRIX_MCP_EMBEDDINGS_MAX_DOCUMENTS", "200000"))
META_FILE = DATA_DIR / "docs.meta.json"
VECTORS_FILE = DATA_DIR / "docs.vectors.npy"
LEGACY_FILE = DATA_DIR / "docs.json"
# e5 models expect "query: " / "passage: " prefixes.
IS_E5 = "e5" in MODEL_NAME.lower()

app = FastAPI(title="Bitrix MCP Embeddings", version="0.2.0")
state_lock = Lock()
index_lock = Lock()
model_lock = Lock()
_model: Any = None
index_state: dict[str, Any] = {"items": [], "matrix": None, "loaded": False, "model": None}


def get_model() -> Any:
    """Loads the sentence-transformers model on first use, so /health answers immediately."""
    global _model
    with model_lock:
        if _model is None:
            from sentence_transformers import SentenceTransformer

            _model = SentenceTransformer(MODEL_NAME)
        return _model


def require_token(authorization: str | None = Header(default=None)) -> None:
    """When BITRIX_MCP_EMBEDDINGS_TOKEN is set, every request needs `Authorization: Bearer <token>`."""
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="Missing or invalid embeddings token")


class Document(BaseModel):
    id: str
    text: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    documents: list[Document] = Field(max_length=MAX_DOCUMENTS)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=5, ge=1, le=50)


def _encode(texts: list[str], kind: str) -> np.ndarray:
    prefixed = [f"{kind}: {text}" for text in texts] if IS_E5 else texts
    vectors = get_model().encode(prefixed, batch_size=BATCH_SIZE, convert_to_numpy=True, normalize_embeddings=True)
    return np.asarray(vectors, dtype=np.float32)


def _atomic_write(path: Path, write: Any) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            write(handle)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _save(items: list[dict[str, Any]], matrix: np.ndarray) -> None:
    _atomic_write(VECTORS_FILE, lambda handle: np.save(handle, matrix))
    meta = {"model": MODEL_NAME, "items": items}
    _atomic_write(META_FILE, lambda handle: handle.write(json.dumps(meta, ensure_ascii=False).encode("utf-8")))


def _load() -> tuple[list[dict[str, Any]], np.ndarray, str | None]:
    if META_FILE.exists() and VECTORS_FILE.exists():
        meta = json.loads(META_FILE.read_text(encoding="utf-8"))
        return meta.get("items", []), np.load(VECTORS_FILE), meta.get("model")
    if LEGACY_FILE.exists():
        # 0.1 format: one JSON array with an "embedding" list per item.
        legacy = json.loads(LEGACY_FILE.read_text(encoding="utf-8"))
        matrix = np.array([item.pop("embedding") for item in legacy], dtype=np.float32) if legacy else np.empty((0, 0), dtype=np.float32)
        return legacy, matrix, None
    return [], np.empty((0, 0), dtype=np.float32), None


def _set_state(items: list[dict[str, Any]], matrix: np.ndarray, model: str | None) -> None:
    index_state.update(items=items, matrix=matrix, loaded=True, model=model)


def _ensure_loaded() -> tuple[list[dict[str, Any]], np.ndarray, str | None]:
    with state_lock:
        if not index_state["loaded"]:
            _set_state(*_load())
        return index_state["items"], index_state["matrix"], index_state["model"]


def _stats() -> dict[str, Any]:
    matrix = index_state["matrix"]
    dimensions = 0 if matrix is None or matrix.size == 0 else int(matrix.shape[1])
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "indexed_model": index_state["model"],
        "index_file": str(META_FILE),
        "loaded": bool(index_state["loaded"]),
        "documents": len(index_state["items"]),
        "dimensions": dimensions,
    }


@app.get("/health", dependencies=[Depends(require_token)])
def health() -> dict[str, Any]:
    _ensure_loaded()
    with state_lock:
        return _stats()


@app.get("/stats", dependencies=[Depends(require_token)])
def stats() -> dict[str, Any]:
    return health()


@app.post("/reload", dependencies=[Depends(require_token)])
def reload_index() -> dict[str, Any]:
    loaded = _load()
    with state_lock:
        _set_state(*loaded)
        return _stats()


@app.post("/index", dependencies=[Depends(require_token)])
def index_documents(request: IndexRequest) -> dict[str, int]:
    # One indexing run at a time; searches keep using the previous index until the swap.
    with index_lock:
        items = [{"id": document.id, "text": document.text, "metadata": document.metadata} for document in request.documents]
        matrix = _encode([document.text for document in request.documents], "passage") if items else np.empty((0, 0), dtype=np.float32)
        _save(items, matrix)
        with state_lock:
            _set_state(items, matrix, MODEL_NAME)
    return {"indexed": len(items)}


@app.post("/search", dependencies=[Depends(require_token)])
def search(request: SearchRequest) -> dict[str, list[dict[str, Any]]]:
    items, matrix, indexed_model = _ensure_loaded()
    if not items:
        raise HTTPException(status_code=404, detail="No documents indexed")
    if indexed_model and indexed_model != MODEL_NAME:
        raise HTTPException(status_code=409, detail=f"Index was built with {indexed_model}, service runs {MODEL_NAME}; rerun `bitrix-mcp index-embeddings`")
    query_vector = _encode([request.query], "query")[0]
    scores = matrix @ query_vector
    order = np.argsort(scores)[::-1][: request.limit]
    return {
        "results": [
            {
                "id": items[int(index)]["id"],
                "score": float(scores[int(index)]),
                "text": items[int(index)]["text"],
                "metadata": items[int(index)].get("metadata", {}),
            }
            for index in order
        ]
    }


if __name__ == "__main__":
    import uvicorn

    # Loopback only by default: the service has no authentication unless BITRIX_MCP_EMBEDDINGS_TOKEN is set.
    uvicorn.run(app, host=os.getenv("BITRIX_MCP_EMBEDDINGS_HOST", "127.0.0.1"), port=int(os.getenv("BITRIX_MCP_EMBEDDINGS_PORT", "8765")))
