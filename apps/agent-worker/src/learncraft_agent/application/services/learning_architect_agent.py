"""学习规划业务 Agent 的工作流注册。

定义：
- LearningArchitectAgent：复用 BaseAgent 并注册学习规划 Agent 的前测工作流。
"""

from __future__ import annotations

from learncraft_agent.application.services.base_agent import BaseAgent
from learncraft_agent.workflows.assessment_generate import AssessmentGenerationWorkflow


class LearningArchitectAgent(BaseAgent):
    """负责学习规划 Agent 的任务分发，当前保留现有前测流程。"""

    def __init__(self) -> None:
        """注册当前已经实现的 assessment_generate 前测工作流。"""
        super().__init__(
            workflows={
                "assessment_generate": AssessmentGenerationWorkflow(),
            },
        )