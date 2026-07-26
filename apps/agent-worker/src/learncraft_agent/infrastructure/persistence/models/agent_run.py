"""Agent 编排表的 SQLAlchemy ORM 映射。

类：
- Base：Agent Worker ORM 映射基类。
- AgentRunModel：映射 agent.agent_runs 的运行状态与审计字段。
- AgentRunEventModel：映射 agent.agent_run_events 的有序运行事件。
"""

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, DateTime, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PostgreSQLUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """仅映射 Agent 自有运行表的 SQLAlchemy 基类。"""


class AgentRunModel(Base):
    """可恢复 AgentRun 的持久化映射，不映射任何 Web 核心业务表。"""

    __tablename__ = "agent_runs"
    __table_args__ = {"schema": "agent"}

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    run_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    trace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    graph_version: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    input_schema_version: Mapped[str] = mapped_column(String(100), nullable=False)
    output_schema_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    requested_model_profile: Mapped[str] = mapped_column(String(100), nullable=False)
    actual_model_profile: Mapped[str | None] = mapped_column(String(100), nullable=True)
    fallback_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False)
    input_summary_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    output_summary_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AgentRunEventModel(Base):
    """AgentRun 的有序审计事件映射。"""

    __tablename__ = "agent_run_events"
    __table_args__ = {"schema": "agent"}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    agent_run_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    sequence_no: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
