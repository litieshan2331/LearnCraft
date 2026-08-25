"""学习路线生成工作流单元测试。

测试：
- test_plan_document_accepts_book_style_dag：验证章节式无环路线合同。
- test_plan_document_rejects_cyclic_dependencies：验证循环依赖被拒绝。
- test_plan_request_allows_model_to_decide_tavily_usage：验证首轮允许模型自主调用 Tavily。
"""

from uuid import uuid4

import orjson

import pytest
from pydantic import SecretStr, ValidationError

from learncraft_agent.application.ports.model_gateway import ModelProviderConnection
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)
from learncraft_agent.workflows.plan_generate import (
    LearningPlanDocument,
    PlanAssessmentInput,
    PlanGenerationInput,
    PlanGenerationWorkflow,
    PlanGoalInput,
    PlanLearnerProfileInput,
    _normalize_recovery_document,
)


def make_document() -> dict[str, object]:
    """构造满足章节顺序和依赖 DAG 的最小路线。"""
    nodes: list[dict[str, object]] = []
    for ordinal in range(1, 7):
        node_key = f"chapter_{ordinal}"
        nodes.append({
            "node_key": node_key,
            "ordinal": ordinal,
            "title": f"第 {ordinal} 章",
            "node_brief": f"学习第 {ordinal} 章的关键概念。",
            "learning_objective": f"能够完成第 {ordinal} 章的学习目标。",
            "rationale": f"第 {ordinal} 章承接前置知识。",
            "difficulty": min(ordinal, 5),
            "estimated_minutes": 45,
            "prerequisite_node_keys": [] if ordinal == 1 else [f"chapter_{ordinal - 1}"],
            "completion_criteria": [f"完成第 {ordinal} 章示例。"],
        })
    return {
        "title": "TypeScript 类型系统学习路线",
        "summary": "从基础类型逐步进入高级类型设计。",
        "nodes": nodes,
    }


def make_input() -> PlanGenerationInput:
    """构造最小路线生成输入快照。"""
    return PlanGenerationInput(
        goal=PlanGoalInput(
            id=str(uuid4()),
            topic="TypeScript 类型系统",
            title="掌握 TypeScript 类型系统",
            description="理解泛型、联合类型和类型收窄。",
            desired_outcome="能独立维护中型 TypeScript 项目。",
        ),
        learner_profile=PlanLearnerProfileInput(
            profile_version=1,
            current_level="intermediate",
            weekly_minutes=360,
        ),
        diagnostic_assessment=PlanAssessmentInput(
            assessment_id=str(uuid4()),
            score_percent=65,
            mastery_summary={"incorrect_count": 4},
        ),
    )


def test_plan_document_accepts_book_style_dag() -> None:
    """章节式路线在编号连续、依赖存在且无环时通过合同校验。"""
    document = LearningPlanDocument.model_validate(make_document())

    assert len(document.nodes) == 6
    assert document.nodes[1].prerequisite_node_keys == ["chapter_1"]


def test_plan_document_rejects_cyclic_dependencies() -> None:
    """章节依赖出现循环时必须被拒绝。"""
    document = make_document()
    nodes = document["nodes"]
    assert isinstance(nodes, list)
    nodes[0]["prerequisite_node_keys"] = ["chapter_6"]

    with pytest.raises(ValidationError, match="无环"):
        LearningPlanDocument.model_validate(document)


def test_recovery_normalizer_converts_legacy_node_fields() -> None:
    """旧格式恢复结果应被确定性收敛为当前章节路线合同。"""
    legacy_document = {
        "schema_version": "v0",
        "description": "从 TypeScript 基础到服务端框架。",
        "nodes": [
            {
                "title": f"章节 {index}",
                "description": f"章节 {index} 摘要。",
                "goal": f"章节 {index} 目标。",
                "dependencies": [] if index == 1 else [f"章节 {index - 1}"],
                "difficulty": "高级" if index > 3 else "中级",
                "completion_criteria": f"完成章节 {index} 示例。",
                "topics": ["legacy-field"],
            }
            for index in range(1, 7)
        ],
    }

    normalized = _normalize_recovery_document(
        orjson.dumps(legacy_document).decode("utf-8"),
    )
    document = LearningPlanDocument.model_validate(normalized)

    assert document.schema_version == "learning_plan.v1"
    assert document.nodes[0].node_key == "chapter_1"
    assert document.nodes[1].prerequisite_node_keys == ["chapter_1"]
    assert document.nodes[0].completion_criteria == ["完成章节 1 示例。"]

def test_plan_request_allows_model_to_decide_tavily_usage() -> None:
    """首轮路线生成应开放 Tavily 且保持 auto 工具策略。"""
    state = AgentRunExecutionState(
        run_id=uuid4(),
        owner_id=uuid4(),
        run_type="plan_generate",
        target_type="learning_goal",
        target_id=uuid4(),
        input_summary_json={},
        status="running",
        should_execute=True,
    )
    connection = ModelProviderConnection(
        owner_id=state.owner_id,
        connection_id=uuid4(),
        base_url="https://api.deepseek.com",
        model_id="deepseek-v4-flash",
        api_key=SecretStr("test-key"),
    )

    request = PlanGenerationWorkflow._build_request(state, make_input(), connection)

    assert request.tool_choice == "auto"
    assert request.response_format == "json_object"
    assert request.tools[0].name == "tavily_search"
    assert request.messages[0].content is not None
    assert "node_key" in request.messages[0].content
