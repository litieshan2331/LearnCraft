"""VectorStore 抽象端口测试。

本文件验证稠密/稀疏向量的数据约束、单模态查询要求，以及 VectorStore 不可被直接实例化。
"""

import pytest

from learncraft_agent.application.ports.vector_store import (
    SparseVector,
    VectorRecord,
    VectorSearchRequest,
    VectorStore,
)


def test_vector_store_is_abstract() -> None:
    """确保具体数据库适配器必须实现所有向量存储操作。"""
    with pytest.raises(TypeError):
        VectorStore()


@pytest.mark.parametrize(
    ("namespace", "query_dense_vector", "query_sparse_vector", "limit"),
    [
        ("", (0.1, 0.2), None, 3),
        ("content_chunks", (), None, 3),
        ("content_chunks", (0.1, 0.2), None, 0),
        ("content_chunks", None, None, 3),
        ("content_chunks", (0.1, 0.2), SparseVector((1,), (0.3,)), 3),
    ],
)
def test_vector_search_request_rejects_invalid_input(
    namespace: str,
    query_dense_vector: tuple[float, ...] | None,
    query_sparse_vector: SparseVector | None,
    limit: int,
) -> None:
    """确保适配器收到的检索请求具备必要上下文。"""
    with pytest.raises(ValueError):
        VectorSearchRequest(
            namespace=namespace,
            limit=limit,
            query_dense_vector=query_dense_vector,
            query_sparse_vector=query_sparse_vector,
        )


def test_vector_store_accepts_sparse_records_and_queries() -> None:
    """确保未来适配器能写入并检索模型产生的稀疏向量。"""
    sparse_vector = SparseVector(indices=(3, 18), values=(0.5, 1.2))

    record = VectorRecord(id="chunk-1", sparse_vector=sparse_vector)
    request = VectorSearchRequest(
        namespace="content_chunks",
        limit=3,
        query_sparse_vector=sparse_vector,
    )

    assert record.sparse_vector == sparse_vector
    assert request.query_sparse_vector == sparse_vector


@pytest.mark.parametrize(
    ("indices", "values"),
    [
        ((), ()),
        ((1,), ()),
        ((1, 1), (0.2, 0.3)),
        ((-1,), (0.2,)),
        ((1,), (0.0,)),
    ],
)
def test_sparse_vector_rejects_invalid_input(
    indices: tuple[int, ...],
    values: tuple[float, ...],
) -> None:
    """确保稀疏向量可以无歧义地映射到具体数据库格式。"""
    with pytest.raises(ValueError):
        SparseVector(indices=indices, values=values)
