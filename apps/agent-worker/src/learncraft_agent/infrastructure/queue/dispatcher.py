"""PostgreSQL Outbox 到 Celery Broker 的可靠投递器。

类：
- ClaimedOutboxEvent：已由当前 Dispatcher 领取的 Outbox 事件快照。
- OutboxDispatcher：使用 FOR UPDATE OF outbox_event SKIP LOCKED 领取，并按 run_type 路由投递与回写。

函数：
- ts_owned_run_types：解析 AGENT_RUNTIME_ROUTES，返回已交给 TypeScript 运行时的 run_type。
- run_dispatcher：循环投递待发送事件。
- main：供 Docker Compose 启动 Dispatcher 的命令行入口。
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import String, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from learncraft_agent.application.dto.agent_run_task import (
    AGENT_RUN_REQUESTED_EVENT_TYPE,
    AgentRunRequestedTask,
)
from learncraft_agent.core.celery_app import CELERY_TASK_NAME, celery_app
from learncraft_agent.core.config import get_queue_settings
from learncraft_agent.infrastructure.persistence.database import create_session_factory

logger = logging.getLogger(__name__)


def ts_owned_run_types(routes_json: str) -> list[str]:
    """解析运行时路由映射，返回已交给 TypeScript 运行时的 run_type 列表。

    未配置或空对象表示尚未灰度：返回空列表，本进程继续领取全部事件（可随时回滚）。
    """
    raw = routes_json.strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("AGENT_RUNTIME_ROUTES 必须是 JSON 对象。") from error
    if not isinstance(parsed, dict):
        raise ValueError("AGENT_RUNTIME_ROUTES 必须是 JSON 对象。")
    return sorted(str(key) for key, value in parsed.items() if value == "ts")


@dataclass(frozen=True)
class ClaimedOutboxEvent:
    """表示当前进程已锁定、必须完成或标记失败的一条 Outbox 事件。"""

    id: UUID
    aggregate_id: UUID
    event_version: int
    payload_json: dict[str, Any]
    attempt_count: int


CLAIM_EVENTS_SQL = """
WITH candidate_events AS (
    SELECT outbox_event.id
    FROM public.outbox_events AS outbox_event
    JOIN agent.agent_runs AS agent_run
      ON agent_run.id = outbox_event.aggregate_id
    WHERE outbox_event.event_type = :event_type
      -- 未灰度时 :ts_owned_run_types 为空，NOT IN 恒真，行为与改造前一致。
      AND agent_run.run_type NOT IN :ts_owned_run_types
      AND (
        (outbox_event.status IN ('pending', 'failed') AND outbox_event.available_at <= now())
        OR (
          outbox_event.status = 'processing'
          AND outbox_event.locked_at < now() - (:lock_timeout_seconds * interval '1 second')
        )
      )
    ORDER BY outbox_event.created_at
    -- 必须写 OF outbox_event：否则会连带锁住 agent.agent_runs，与 begin_execution 行锁互相阻塞。
    FOR UPDATE OF outbox_event SKIP LOCKED
    LIMIT :batch_size
)
UPDATE public.outbox_events AS outbox_event
SET status = 'processing',
    locked_by = :dispatcher_id,
    locked_at = now(),
    attempt_count = outbox_event.attempt_count + 1,
    last_error = NULL
FROM candidate_events
WHERE outbox_event.id = candidate_events.id
RETURNING
    outbox_event.id,
    outbox_event.aggregate_id,
    outbox_event.event_version,
    outbox_event.payload_json,
    outbox_event.attempt_count
"""


class OutboxDispatcher:
    """将 Web 事务内创建的 AgentRunRequested 事件投递到 Celery。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self._settings = get_queue_settings()
        # 已交给 TypeScript 运行时的 run_type：本进程必须跳过，避免两个运行时抢同一事件。
        self._ts_owned_run_types = ts_owned_run_types(self._settings.agent_runtime_routes)

    async def dispatch_once(self) -> int:
        """领取一个批次的事件并逐条投递，返回本轮领取数量。"""
        claimed_events = await self._claim_events()
        for event in claimed_events:
            await self._dispatch_event(event)
        return len(claimed_events)

    async def _claim_events(self) -> list[ClaimedOutboxEvent]:
        """使用 FOR UPDATE SKIP LOCKED 安全领取未投递或过期锁定的事件。"""
        # 必须显式给出元素类型：否则展开绑定的类型推断会让 varchar 与 integer 比较而报错。
        query = text(CLAIM_EVENTS_SQL).bindparams(
            bindparam("ts_owned_run_types", type_=String, expanding=True),
        )
        async with self._session_factory() as session, session.begin():
            result = await session.execute(
                query,
                {
                    "event_type": AGENT_RUN_REQUESTED_EVENT_TYPE,
                    "lock_timeout_seconds": self._settings.outbox_lock_timeout_seconds,
                    "batch_size": self._settings.outbox_batch_size,
                    "dispatcher_id": self._settings.outbox_dispatcher_id,
                    "ts_owned_run_types": self._ts_owned_run_types,
                },
            )
            rows = result.mappings().all()

        return [
            ClaimedOutboxEvent(
                id=row["id"],
                aggregate_id=row["aggregate_id"],
                event_version=row["event_version"],
                payload_json=row["payload_json"],
                attempt_count=row["attempt_count"],
            )
            for row in rows
        ]

    async def _dispatch_event(self, event: ClaimedOutboxEvent) -> None:
        """验证事件并发送到 Broker；失败时根据尝试次数安排后续投递。"""
        try:
            task = self._parse_task(event)
            celery_app.send_task(
                CELERY_TASK_NAME,
                kwargs={"payload": task.model_dump(mode="json")},
                task_id=str(task.agent_run_id),
                queue=self._settings.celery_queue_name,
            )
        except ValidationError as error:
            await self._mark_dead(event, f"事件载荷不符合契约：{error.__class__.__name__}")
        except ValueError as error:
            await self._mark_dead(event, str(error))
        except Exception as error:
            logger.exception(
                "Outbox 事件投递到 Celery 失败",
                extra={"outbox_event_id": str(event.id)},
            )
            await self._mark_retryable_failure(event, error.__class__.__name__)
        else:
            await self._mark_published(event)

    def _parse_task(self, event: ClaimedOutboxEvent) -> AgentRunRequestedTask:
        """确保 Outbox 聚合标识、版本和载荷与当前 Agent 任务契约一致。"""
        if event.event_version != 1:
            raise ValueError(f"不支持的 Outbox 事件版本：{event.event_version}")
        task = AgentRunRequestedTask.model_validate(event.payload_json)
        if task.agent_run_id != event.aggregate_id:
            raise ValueError("Outbox aggregate_id 与 agent_run_id 不一致。")
        return task

    async def _mark_published(self, event: ClaimedOutboxEvent) -> None:
        """仅由当前锁持有者将已发送到 Broker 的事件标记为 published。"""
        await self._execute_status_update(
            event.id,
            """
            status = 'published',
            published_at = now(),
            locked_by = NULL,
            locked_at = NULL,
            last_error = NULL
            """,
        )

    async def _mark_dead(self, event: ClaimedOutboxEvent, error_summary: str) -> None:
        """将无法通过重试恢复的契约错误转入 dead 状态等待人工处理。"""
        logger.error(
            "Outbox 事件已转入 dead 状态",
            extra={"outbox_event_id": str(event.id), "error": error_summary},
        )
        await self._execute_status_update(
            event.id,
            """
            status = 'dead',
            locked_by = NULL,
            locked_at = NULL,
            last_error = :error_summary
            """,
            {"error_summary": error_summary[:1_000]},
        )

    async def _mark_retryable_failure(
        self,
        event: ClaimedOutboxEvent,
        error_summary: str,
    ) -> None:
        """对 Broker 暂时不可用等错误记录退避时间，避免忙等重试。"""
        if event.attempt_count >= self._settings.outbox_max_attempts:
            await self._mark_dead(event, f"投递重试耗尽：{error_summary}")
            return

        delay_seconds = min(300, 10 * 2 ** max(0, event.attempt_count - 1))
        await self._execute_status_update(
            event.id,
            """
            status = 'failed',
            available_at = now() + (:delay_seconds * interval '1 second'),
            locked_by = NULL,
            locked_at = NULL,
            last_error = :error_summary
            """,
            {
                "delay_seconds": delay_seconds,
                "error_summary": error_summary[:1_000],
            },
        )

    async def _execute_status_update(
        self,
        event_id: UUID,
        assignments: str,
        extra_parameters: dict[str, object] | None = None,
    ) -> None:
        """以 Dispatcher 锁拥有者条件回写 Outbox，防止竞争进程覆盖状态。"""
        parameters: dict[str, object] = {
            "event_id": event_id,
            "dispatcher_id": self._settings.outbox_dispatcher_id,
        }
        if extra_parameters:
            parameters.update(extra_parameters)

        query = text(
            f"""
            UPDATE public.outbox_events
            SET {assignments}
            WHERE id = :event_id
              AND status = 'processing'
              AND locked_by = :dispatcher_id
            """,
        )
        async with self._session_factory() as session, session.begin():
            await session.execute(query, parameters)


async def run_dispatcher() -> None:
    """持续运行 Dispatcher；空闲时低频轮询，异常时保留进程供 Docker 重启。"""
    settings = get_queue_settings()
    dispatcher = OutboxDispatcher(create_session_factory())
    while True:
        try:
            claimed_count = await dispatcher.dispatch_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Outbox Dispatcher 本轮轮询失败")
            await asyncio.sleep(settings.outbox_poll_interval_seconds)
        else:
            if claimed_count == 0:
                await asyncio.sleep(settings.outbox_poll_interval_seconds)


def main() -> None:
    """启动独立的 PostgreSQL Outbox Dispatcher 进程。"""
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_dispatcher())
