"""模型连接受控出网审计的 SQLAlchemy ORM 映射。

类：
- ModelConnectionEgressAuditModel：映射 public.model_connection_egress_audits 的最小安全审计字段。
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column

from learncraft_agent.infrastructure.persistence.models.agent_run import Base


class ModelConnectionEgressAuditModel(Base):
    """只映射模型出网审计表；不映射用户、模型连接等 Web 业务实体。"""

    __tablename__ = "model_connection_egress_audits"

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    model_connection_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        nullable=False,
    )
    agent_run_id: Mapped[UUID | None] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        nullable=True,
    )
    host: Mapped[str | None] = mapped_column(String(253), nullable=True)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    reason_code: Mapped[str] = mapped_column(String(100), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
