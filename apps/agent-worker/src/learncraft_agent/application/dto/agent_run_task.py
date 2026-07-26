"""AgentRun 队列消息 DTO。

类：
- AgentRunRequestedTask：Web Outbox 投递给 Celery 的最小、可版本化任务载荷。
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AGENT_RUN_REQUESTED_EVENT_TYPE = "agent.run.requested"


class AgentRunRequestedTask(BaseModel):
    """仅携带定位运行所需字段，敏感输入始终保留在 PostgreSQL 中。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_run_id: UUID
    trace_id: str = Field(min_length=1, max_length=128)
    task_version: Literal[1] = 1
