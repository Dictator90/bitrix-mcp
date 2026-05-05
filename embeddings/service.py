from __future__ import annotations

import json
import os
from pathlib import Path
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


class Document(BaseModel):
    id: str
    text: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    documents: list[Document]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=50)


def _load() -> list[dict[str, Any]]:
    if not INDEX_FILE.exists():
        return []
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def _save(items: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return vectors / norms


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_NAME}


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
    return {"indexed": len(items)}


@app.post("/search")
def search(request: SearchRequest) -> dict[str, list[dict[str, Any]]]:
    items = _load()
    if not items:
        raise HTTPException(status_code=404, detail="No documents indexed")
    query_vector = model.encode([request.query], convert_to_numpy=True, normalize_embeddings=True)[0]
    matrix = _normalize(np.array([item["embedding"] for item in items], dtype=np.float32))
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
