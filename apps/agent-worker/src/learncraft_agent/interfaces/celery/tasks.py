"""Celery 对 AgentRun 消息的消费适配器。

函数：
- execute_agent_run_task：校验队列载荷、执行生命周期命令，并处理重试或最终失败。
- calculate_retry_delay_seconds：计算有上限的指数退避时间。
"""

import asyncio
import logging

from celery import Task

from learncraft_agent.application.commands.execute_agent_run import (
    NonRetryableAgentRunError,
    RetryableAgentRunError,
    execute_agent_run,
)
from learncraft_agent.application.dto.agent_run_task import AgentRunRequestedTask
from learncraft_agent.core.celery_app import CELERY_TASK_NAME, celery_app
from learncraft_agent.core.config import get_queue_settings
from learncraft_agent.infrastructure.persistence.database import create_session_factory
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    SqlAlchemyAgentRunRepository,
)

logger = logging.getLogger(__name__)


@celery_app.task(
    bind=True,
    name=CELERY_TASK_NAME,
    acks_late=True,
    reject_on_worker_lost=True,
    ignore_result=True,
)
def execute_agent_run_task(
    self: Task,
    payload: dict[str, object],
) -> None:
    """执行一条 AgentRun 消息；仅临时故障会进入 Celery 延迟重试。"""
    task = AgentRunRequestedTask.model_validate(payload)
    settings = get_queue_settings()
    repository = SqlAlchemyAgentRunRepository(create_session_factory())
    current_retry_count = self.request.retries

    try:
        asyncio.run(
            execute_agent_run(
                task=task,
                retry_count=current_retry_count,
                repository=repository,
            ),
        )
    except RetryableAgentRunError as error:
        next_retry_count = current_retry_count + 1
        if current_retry_count >= settings.celery_task_max_retries:
            asyncio.run(
                repository.mark_failed(
                    run_id=task.agent_run_id,
                    error_code="AGENT_RUN_RETRY_EXHAUSTED",
                    error_summary=type(error).__name__,
                ),
            )
            raise

        delay_seconds = calculate_retry_delay_seconds(next_retry_count)
        asyncio.run(
            repository.mark_retry_scheduled(
                run_id=task.agent_run_id,
                retry_count=next_retry_count,
                delay_seconds=delay_seconds,
                error_code="AGENT_RUN_RETRYABLE_ERROR",
            ),
        )
        raise self.retry(exc=error, countdown=delay_seconds) from error
    except NonRetryableAgentRunError as error:
        asyncio.run(
            repository.mark_failed(
                run_id=task.agent_run_id,
                error_code="AGENT_RUN_WORKFLOW_NOT_REGISTERED",
                error_summary=type(error).__name__,
            ),
        )
        raise
    except Exception as error:
        logger.exception(
            "AgentRun 执行出现未分类错误",
            extra={"agent_run_id": str(task.agent_run_id)},
        )
        asyncio.run(
            repository.mark_failed(
                run_id=task.agent_run_id,
                error_code="AGENT_RUN_UNEXPECTED_ERROR",
                error_summary=type(error).__name__,
            ),
        )
        raise


def calculate_retry_delay_seconds(next_retry_count: int) -> int:
    """按照已批准的 10/20/40… 秒策略计算最长五分钟的延迟。"""
    settings = get_queue_settings()
    return min(
        settings.celery_retry_backoff_max_seconds,
        settings.celery_retry_backoff_seconds * 2 ** max(0, next_retry_count - 1),
    )
