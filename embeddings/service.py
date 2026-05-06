from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("BITRIX_MCP_EMBEDDINGS_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
DATA_DIR = Path(os.getenv("BITRIX_MCP_EMBEDDINGS_DATA", ".bitrix-mcp/embeddings"))
INDEX_FILE = DATA_DIR / "docs.json"

app = FastAPI(title="Bitrix MCP Embeddings", version="0.1.0")
model = SentenceTransformer(MODEL_NAME)
state_lock = Lock()
index_state: dict[str, Any] = {
    "items": [],
    "matrix": None,
    "mtime": None,
    "loaded": False,
}


class Document(BaseModel):
    id: str
    text: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    documents: list[Document]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=50)


def _load_file() -> list[dict[str, Any]]:
    if not INDEX_FILE.exists():
        return []
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def _save(items: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize(vectors: np.ndarray) -> np.ndarray:
    if vectors.size == 0:
        return vectors.reshape(0, 0)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return vectors / norms


def _build_matrix(items: list[dict[str, Any]]) -> np.ndarray:
    if not items:
        return np.empty((0, 0), dtype=np.float32)
    return _normalize(np.array([item["embedding"] for item in items], dtype=np.float32))


def _file_mtime() -> float | None:
    if not INDEX_FILE.exists():
        return None
    return INDEX_FILE.stat().st_mtime


def _set_state(items: list[dict[str, Any]], loaded: bool = True) -> None:
    index_state["items"] = items
    index_state["matrix"] = _build_matrix(items)
    index_state["mtime"] = _file_mtime()
    index_state["loaded"] = loaded


def _ensure_loaded() -> tuple[list[dict[str, Any]], np.ndarray]:
    with state_lock:
        if not index_state["loaded"]:
            _set_state(_load_file())
        return index_state["items"], index_state["matrix"]


def _stats() -> dict[str, Any]:
    matrix = index_state["matrix"]
    dimensions = 0 if matrix is None or matrix.size == 0 else int(matrix.shape[1])
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "index_file": str(INDEX_FILE),
        "loaded": bool(index_state["loaded"]),
        "documents": len(index_state["items"]),
        "dimensions": dimensions,
        "mtime": index_state["mtime"],
    }


@app.get("/health")
def health() -> dict[str, Any]:
    with state_lock:
        return _stats()


@app.get("/stats")
def stats() -> dict[str, Any]:
    with state_lock:
        return _stats()


@app.post("/reload")
def reload_index() -> dict[str, Any]:
    with state_lock:
        _set_state(_load_file())
        return _stats()


@app.post("/index")
def index_documents(request: IndexRequest) -> dict[str, int]:
    embeddings = model.encode([document.text for document in request.documents], convert_to_numpy=True, normalize_embeddings=True)
    items = []
    for document, vector in zip(request.documents, embeddings, strict=True):
        items.append({
            "id": document.id,
            "text": document.text,
            "metadata": document.metadata,
            "embedding": vector.astype(float).tolist(),
        })
    _save(items)
    with state_lock:
        _set_state(items)
    return {"indexed": len(items)}


@app.post("/search")
def search(request: SearchRequest) -> dict[str, list[dict[str, Any]]]:
    items, matrix = _ensure_loaded()
    if not items:
        raise HTTPException(status_code=404, detail="No documents indexed")
    query_vector = model.encode([request.query], convert_to_numpy=True, normalize_embeddings=True)[0]
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
