"""模型受控出网审计的 SQLAlchemy Repository。

类：
- SqlAlchemyModelEgressAuditRepository：写入最小审计事件，并在写入时清理已超过保留期的数据。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from learncraft_agent.application.ports.model_egress_audit import ModelEgressAuditEntry
from learncraft_agent.infrastructure.persistence.models.model_connection_egress_audit import (
    ModelConnectionEgressAuditModel,
)


class SqlAlchemyModelEgressAuditRepository:
    """持久化不含密钥和请求正文的模型出网决策，默认按配置保留 30 天。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        retention_days: int,
    ) -> None:
        self._session_factory = session_factory
        self._retention = timedelta(days=retention_days)

    async def record(self, entry: ModelEgressAuditEntry) -> None:
        """在同一事务中清理到期审计行并保存当前安全决策。"""
        now = datetime.now(timezone.utc)
        async with self._session_factory() as session, session.begin():
            await session.execute(
                delete(ModelConnectionEgressAuditModel).where(
                    ModelConnectionEgressAuditModel.expires_at <= now,
                ),
            )
            session.add(
                ModelConnectionEgressAuditModel(
                    owner_id=entry.owner_id,
                    model_connection_id=entry.model_connection_id,
                    agent_run_id=entry.agent_run_id,
                    host=entry.host,
                    port=entry.port,
                    decision=entry.decision,
                    reason_code=entry.reason_code,
                    occurred_at=now,
                    expires_at=now + self._retention,
                ),
            )
