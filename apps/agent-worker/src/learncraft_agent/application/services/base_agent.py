"""共享 Agent 执行框架。

定义：
- AgentWorkflow：业务工作流的最小异步执行协议。
- AgentWorkflowNotRegisteredError：表示任务类型尚未注册。
- BaseAgent：按 run_type 分发工作流并传递统一 AgentRun 上下文。
"""

from __future__ import annotations

from typing import Any, Protocol

from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)


class AgentWorkflow(Protocol):
    """定义可挂载到 BaseAgent 的业务工作流。"""

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        """执行一个已经领取的 AgentRun 工作流。"""


class AgentWorkflowNotRegisteredError(RuntimeError):
    """表示当前业务 Agent 没有注册指定的 run_type。"""

    def __init__(self, run_type: str) -> None:
        super().__init__(f"尚未注册 run_type={run_type} 的 Agent 工作流。")
        self.run_type = run_type


class BaseAgent:
    """共享工作流路由边界，不包含具体学习业务规则。"""

    def __init__(self, *, workflows: dict[str, AgentWorkflow]) -> None:
        self._workflows = dict(workflows)

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        """根据 run_type 选择业务工作流并返回已验证结果摘要。"""
        workflow = self._workflows.get(state.run_type)
        if workflow is None:
            raise AgentWorkflowNotRegisteredError(state.run_type)
        return await workflow.run(state)