"""节点教学业务 Agent 的工作流注册。

定义：
- NodeTutorAgent：复用 BaseAgent，注册节点内容和节点后测工作流。
"""

from __future__ import annotations

from learncraft_agent.application.services.base_agent import BaseAgent
from learncraft_agent.workflows.card_content_generate import CardContentWorkflow


class NodeTutorAgent(BaseAgent):
    """负责同一 plan_node 逻辑会话中的节点内容和后测任务分发。"""

    def __init__(self) -> None:
        """注册 card_content_generate；posttest_generate 将在后续内容后测实现中接入。"""
        super().__init__(
            workflows={
                "card_content_generate": CardContentWorkflow(),
            },
        )