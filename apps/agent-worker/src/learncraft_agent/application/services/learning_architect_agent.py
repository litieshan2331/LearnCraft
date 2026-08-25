"""学习规划业务 Agent 的工作流注册。

定义：
- LearningArchitectAgent：复用 BaseAgent 并注册学习规划 Agent 的前测与路线工作流。
"""

from __future__ import annotations

from learncraft_agent.application.services.base_agent import BaseAgent
from learncraft_agent.workflows.assessment_generate import AssessmentGenerationWorkflow
from learncraft_agent.workflows.plan_generate import PlanGenerationWorkflow


class LearningArchitectAgent(BaseAgent):
    """负责学习规划 Agent 的前测与学习路线任务分发。"""

    def __init__(self) -> None:
        """注册 assessment_generate 前测与 plan_generate 路线工作流。"""
        super().__init__(
            workflows={
                "assessment_generate": AssessmentGenerationWorkflow(),
                "plan_generate": PlanGenerationWorkflow(),
            },
        )
