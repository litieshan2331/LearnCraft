"""AgentRun Celery 任务载荷测试。

函数：
- test_agent_run_task_accepts_the_v1_contract：验证 v1 最小消息可被 Pydantic 接收。
- test_agent_run_task_rejects_extra_fields：防止敏感或未评审字段进入 Redis Broker。
"""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from learncraft_agent.application.dto.agent_run_task import AgentRunRequestedTask


def test_agent_run_task_accepts_the_v1_contract() -> None:
    """验证 Dispatcher 与 Worker 共用的最小载荷。"""
    run_id = uuid4()

    task = AgentRunRequestedTask.model_validate(
        {
            "agent_run_id": str(run_id),
            "trace_id": "trace-001",
            "task_version": 1,
        },
    )

    assert task.agent_run_id == run_id
    assert task.task_version == 1


def test_agent_run_task_rejects_extra_fields() -> None:
    """阻止完整 Prompt 等不应进入 Redis 的字段被悄悄接受。"""
    with pytest.raises(ValidationError):
        AgentRunRequestedTask.model_validate(
            {
                "agent_run_id": str(uuid4()),
                "trace_id": "trace-001",
                "task_version": 1,
                "prompt": "不应投递到 Broker 的敏感内容",
            },
        )
