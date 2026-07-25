"""向量存储应用端口。

本文件定义 SparseVector、VectorRecord、VectorSearchRequest、VectorSearchHit 与
VectorStore。它让检索工作流只依赖统一契约，具体实现可在 pgvector 与 Milvus
间替换，并同时承载稠密和稀疏向量；词法全文检索仍由独立的检索端口负责。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from math import isfinite
from typing import Mapping, Sequence


@dataclass(frozen=True, slots=True)
class SparseVector:
    """以非零维度索引和值表示的稀疏向量，可映射到 pgvector 或 Milvus。"""

    indices: tuple[int, ...]
    values: tuple[float, ...]

    def __post_init__(self) -> None:
        """校验稀疏向量的索引、数值和一一对应关系。"""
        if not self.indices:
            raise ValueError("稀疏向量不能为空")
        if len(self.indices) != len(self.values):
            raise ValueError("稀疏向量的 indices 与 values 长度必须一致")
        if any(
            not isinstance(index, int) or isinstance(index, bool) or index < 0
            for index in self.indices
        ):
            raise ValueError("稀疏向量索引必须是非负整数")
        if len(set(self.indices)) != len(self.indices):
            raise ValueError("稀疏向量索引不能重复")
        if any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not isfinite(value)
            or value == 0
            for value in self.values
        ):
            raise ValueError("稀疏向量值必须是非零有限数值")


def _validate_dense_vector(
    vector: tuple[float, ...],
    *,
    field_name: str,
) -> None:
    """校验稠密向量非空且只包含有限数值。"""
    if not vector:
        raise ValueError(f"{field_name} 不能为空")
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not isfinite(value)
        for value in vector
    ):
        raise ValueError(f"{field_name} 必须只包含有限数值")


@dataclass(frozen=True, slots=True)
class VectorRecord:
    """待写入向量存储的一条记录，可同时附带稠密和稀疏向量。"""

    id: str
    dense_vector: tuple[float, ...] | None = None
    sparse_vector: SparseVector | None = None
    metadata: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """校验记录标识和至少一种待写入的向量表示。"""
        if not self.id:
            raise ValueError("记录 id 不能为空")
        if self.dense_vector is None and self.sparse_vector is None:
            raise ValueError("记录至少需要提供一种向量表示")
        if self.dense_vector is not None:
            _validate_dense_vector(self.dense_vector, field_name="dense_vector")


@dataclass(frozen=True, slots=True)
class VectorSearchRequest:
    """一次单模态向量召回请求；混合排序由上层分别召回后融合。"""

    namespace: str
    limit: int
    query_dense_vector: tuple[float, ...] | None = None
    query_sparse_vector: SparseVector | None = None
    metadata_filter: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """校验召回条数、命名空间和唯一的查询向量模态。"""
        if not self.namespace:
            raise ValueError("namespace 不能为空")
        if self.limit < 1:
            raise ValueError("limit 必须大于 0")
        if self.query_dense_vector is None and self.query_sparse_vector is None:
            raise ValueError("查询至少需要提供一种向量表示")
        if self.query_dense_vector is not None and self.query_sparse_vector is not None:
            raise ValueError("单次查询只能提供一种向量表示")
        if self.query_dense_vector is not None:
            _validate_dense_vector(
                self.query_dense_vector,
                field_name="query_dense_vector",
            )


@dataclass(frozen=True, slots=True)
class VectorSearchHit:
    """一次召回命中的统一结果；score 越高表示相关性越高。"""

    id: str
    score: float
    metadata: Mapping[str, object] = field(default_factory=dict)


class VectorStore(ABC):
    """向量存储抽象类，隔离具体数据库 SDK、索引和距离计算细节。

    单次 search 只检索一种向量模态，避免将数据库专有的混合评分公式泄漏到契约；
    上层 HybridRetriever 可分别发起 dense、sparse 或 FTS 查询，再以 RRF 融合排序。
    """

    @abstractmethod
    async def upsert(
        self,
        *,
        namespace: str,
        records: Sequence[VectorRecord],
    ) -> None:
        """在指定命名空间新增或覆盖包含稠密/稀疏向量的记录。"""

    @abstractmethod
    async def delete(self, *, namespace: str, record_ids: Sequence[str]) -> None:
        """删除指定命名空间内的向量记录。"""

    @abstractmethod
    async def search(
        self,
        request: VectorSearchRequest,
    ) -> Sequence[VectorSearchHit]:
        """按 metadata 过滤并返回单模态、按统一相关性分数排序的结果。"""
