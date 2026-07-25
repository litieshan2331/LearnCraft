"""Agent Port 抽象包。

本包声明 Core API、LLM、检索、执行器、队列、Checkpoint 与向量存储的抽象接口。
其中 VectorStore 用于隔离 pgvector、Milvus 等具体向量数据库，并支持稠密、稀疏向量。
"""

from learncraft_agent.application.ports.vector_store import (
    SparseVector,
    VectorRecord,
    VectorSearchHit,
    VectorSearchRequest,
    VectorStore,
)

__all__ = [
    "SparseVector",
    "VectorRecord",
    "VectorSearchHit",
    "VectorSearchRequest",
    "VectorStore",
]
