"""AgentRun 生命周期的 SQLAlchemy Repository 实现。

类：
- AgentRunExecutionState：任务领取后的可执行状态快照。
- SqlAlchemyAgentRunRepository：负责运行状态、取消检查与有序审计事件。
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from learncraft_agent.infrastructure.persistence.models.agent_run import (
    AgentRunEventModel,
    AgentRunModel,
)

TERMINAL_AGENT_RUN_STATUSES = frozenset({"succeeded", "failed", "cancelled", "expired"})


@dataclass(frozen=True)
class AgentRunExecutionState:
    """表示一个 Celery 消息当前是否还应继续执行。"""

    run_id: UUID
    owner_id: UUID
    run_type: str
    target_type: str
    target_id: UUID
    input_summary_json: dict[str, Any]
    status: str
    should_execute: bool


class SqlAlchemyAgentRunRepository:
    """只维护 agent schema 中的运行状态，绝不写入 Web 核心业务表。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def begin_execution(
        self,
        *,
        run_id: UUID,
        trace_id: str,
        retry_count: int,
    ) -> AgentRunExecutionState:
        """锁定 AgentRun，并在未终止时将其推进到运行中状态。"""
        async with self._session_factory() as session, session.begin():
            agent_run = await self._get_locked_run(session, run_id)
            self._ensure_trace_matches(agent_run, trace_id)

            if agent_run.status in TERMINAL_AGENT_RUN_STATUSES:
                return AgentRunExecutionState(
                    run_id=agent_run.id,
                    owner_id=agent_run.owner_id,
                    run_type=agent_run.run_type,
                    target_type=agent_run.target_type,
                    target_id=agent_run.target_id,
                    input_summary_json=agent_run.input_summary_json,
                    status=agent_run.status,
                    should_execute=False,
                )

            now = datetime.now(timezone.utc)
            agent_run.retry_count = max(agent_run.retry_count, retry_count)
            if agent_run.status == "queued":
                agent_run.status = "running"
                if agent_run.started_at is None:
                    agent_run.started_at = now
                await self._append_event(
                    session,
                    agent_run.id,
                    "run.started",
                    {"retry_count": agent_run.retry_count},
                )
            elif agent_run.status == "running":
                await self._append_event(
                    session,
                    agent_run.id,
                    "run.resumed",
                    {"retry_count": agent_run.retry_count},
                )
            else:
                raise ValueError(f"不支持的 AgentRun 状态：{agent_run.status}")

            return AgentRunExecutionState(
                run_id=agent_run.id,
                owner_id=agent_run.owner_id,
                run_type=agent_run.run_type,
                target_type=agent_run.target_type,
                target_id=agent_run.target_id,
                input_summary_json=agent_run.input_summary_json,
                status=agent_run.status,
                should_execute=True,
            )

    async def is_cancelled(self, run_id: UUID) -> bool:
        """查询 Web 是否已将当前运行标记为协作式取消。"""
        async with self._session_factory() as session:
            status = await session.scalar(
                select(AgentRunModel.status).where(AgentRunModel.id == run_id),
            )
        return status == "cancelled"

    async def mark_succeeded(
        self,
        *,
        run_id: UUID,
        output_summary: dict[str, Any],
        input_tokens: int = 0,
        output_tokens: int = 0,
        actual_model_profile: str | None = None,
    ) -> None:
        """持久化成功摘要与 token 用量，并追加可审计的成功事件。"""
        async with self._session_factory() as session, session.begin():
            agent_run = await self._get_locked_run(session, run_id)
            if agent_run.status in TERMINAL_AGENT_RUN_STATUSES:
                return
            agent_run.status = "succeeded"
            agent_run.output_summary_json = output_summary
            agent_run.input_tokens = max(0, input_tokens)
            agent_run.output_tokens = max(0, output_tokens)
            agent_run.actual_model_profile = actual_model_profile
            agent_run.error_code = None
            agent_run.error_summary = None
            agent_run.finished_at = datetime.now(timezone.utc)
            await self._append_event(
                session,
                agent_run.id,
                "run.succeeded",
                {"input_tokens": agent_run.input_tokens, "output_tokens": agent_run.output_tokens},
            )

    async def mark_retry_scheduled(
        self,
        *,
        run_id: UUID,
        retry_count: int,
        delay_seconds: int,
        error_code: str,
    ) -> None:
        """记录可恢复错误，并将运行重新置为等待下一次 Celery 重试。"""
        async with self._session_factory() as session, session.begin():
            agent_run = await self._get_locked_run(session, run_id)
            if agent_run.status in TERMINAL_AGENT_RUN_STATUSES:
                return
            agent_run.status = "queued"
            agent_run.retry_count = max(agent_run.retry_count, retry_count)
            agent_run.error_code = error_code
            agent_run.error_summary = None
            await self._append_event(
                session,
                agent_run.id,
                "run.retry_scheduled",
                {
                    "retry_count": agent_run.retry_count,
                    "delay_seconds": delay_seconds,
                    "error_code": error_code,
                },
            )

    async def mark_failed(
        self,
        *,
        run_id: UUID,
        error_code: str,
        error_summary: str,
    ) -> None:
        """以不泄露敏感输入的摘要写入最终失败状态。"""
        async with self._session_factory() as session, session.begin():
            agent_run = await self._get_locked_run(session, run_id)
            if agent_run.status in TERMINAL_AGENT_RUN_STATUSES:
                return
            agent_run.status = "failed"
            agent_run.error_code = error_code[:100]
            agent_run.error_summary = error_summary[:1_000]
            agent_run.finished_at = datetime.now(timezone.utc)
            await self._append_event(
                session,
                agent_run.id,
                "run.failed",
                {"error_code": agent_run.error_code},
            )

    async def _get_locked_run(self, session: AsyncSession, run_id: UUID) -> AgentRunModel:
        """以行锁读取运行，防止重复投递并发写出相同事件序号。"""
        agent_run = await session.scalar(
            select(AgentRunModel)
            .where(AgentRunModel.id == run_id)
            .with_for_update(),
        )
        if agent_run is None:
            raise LookupError(f"AgentRun 不存在：{run_id}")
        return agent_run

    async def _append_event(
        self,
        session: AsyncSession,
        agent_run_id: UUID,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """在已锁定的 AgentRun 下追加严格递增的审计事件。"""
        last_sequence = await session.scalar(
            select(func.coalesce(func.max(AgentRunEventModel.sequence_no), 0)).where(
                AgentRunEventModel.agent_run_id == agent_run_id,
            ),
        )
        session.add(
            AgentRunEventModel(
                agent_run_id=agent_run_id,
                sequence_no=int(last_sequence) + 1,
                event_type=event_type,
                payload_json=payload,
                occurred_at=datetime.now(timezone.utc),
            ),
        )

    @staticmethod
    def _ensure_trace_matches(agent_run: AgentRunModel, trace_id: str) -> None:
        """阻断消息载荷与持久化运行不一致的错误投递。"""
        if agent_run.trace_id != trace_id:
            raise ValueError("Celery 消息的 trace_id 与 AgentRun 不匹配。")
