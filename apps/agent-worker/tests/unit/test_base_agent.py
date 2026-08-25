"""BaseAgent 共享执行框架的单元测试。

测试：
- test_base_agent_dispatches_registered_workflow：验证已注册任务按 run_type 分发。
- test_base_agent_rejects_unregistered_workflow：验证未注册任务返回稳定错误。
"""

from uuid import uuid4

import pytest

from learncraft_agent.application.services.base_agent import (
    AgentWorkflowNotRegisteredError,
    BaseAgent,
)
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)


class FakeWorkflow:
    """记录调用并返回固定结果的测试工作流。"""

    def __init__(self) -> None:
        self.states: list[AgentRunExecutionState] = []

    async def run(self, state: AgentRunExecutionState) -> dict[str, str]:
        """记录输入状态并返回测试摘要。"""
        self.states.append(state)
        return {"status": "ok"}


def make_state(run_type: str) -> AgentRunExecutionState:
    """构造最小可执行 AgentRun 状态。"""
    return AgentRunExecutionState(
        run_id=uuid4(),
        owner_id=uuid4(),
        run_type=run_type,
        target_type="learning_goal",
        target_id=uuid4(),
        input_summary_json={},
        status="running",
        should_execute=True,
    )


@pytest.mark.asyncio
async def test_base_agent_dispatches_registered_workflow() -> None:
    """已注册任务应收到原始 AgentRun 状态并返回工作流摘要。"""
    workflow = FakeWorkflow()
    agent = BaseAgent(workflows={"assessment_generate": workflow})
    state = make_state("assessment_generate")

    result = await agent.run(state)

    assert result == {"status": "ok"}
    assert workflow.states == [state]


@pytest.mark.asyncio
async def test_base_agent_rejects_unregistered_workflow() -> None:
    """未注册任务应抛出包含 run_type 的稳定错误。"""
    agent = BaseAgent(workflows={})

    with pytest.raises(AgentWorkflowNotRegisteredError, match="plan_generate"):
        await agent.run(make_state("plan_generate"))