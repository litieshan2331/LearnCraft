"""节点内容工作流和 NodeTutorAgent 的单元测试。

测试：
- test_card_content_document_accepts_required_sections：验证三段式内容合同。
- test_card_content_request_allows_model_to_decide_tavily_usage：验证首轮允许模型自主调用 Tavily。
- test_node_tutor_registers_card_content_workflow：验证 card_content_generate 不再是未注册工作流。
"""

from uuid import uuid4

import orjson

import pytest
from pydantic import SecretStr

from learncraft_agent.application.ports.model_gateway import ModelProviderConnection
from learncraft_agent.application.services.node_tutor_agent import NodeTutorAgent
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)
from learncraft_agent.workflows.card_content_generate import (
    CardContentDocument,
    CardContentGenerationInput,
    CardContentWorkflow,
)


def make_input() -> CardContentGenerationInput:
    """构造最小节点教学输入快照。"""
    return CardContentGenerationInput.model_validate({
        "agent_role": "node_tutor",
        "logical_session_key": "node:example",
        "goal": {
            "id": str(uuid4()),
            "topic": "Python 数据分析",
            "title": "掌握 Python 数据分析",
            "desired_outcome": "完成基础数据分析。",
        },
        "learner_profile": {
            "profile_version": 1,
            "current_level": "beginner",
            "weekly_minutes": 300,
        },
        "learning_plan": {"id": str(uuid4())},
        "plan_node": {
            "id": str(uuid4()),
            "title": "Python 变量与表达式",
            "node_brief": "理解变量、表达式和基础数据类型。",
            "learning_objective": "能够使用变量完成简单计算。",
            "completion_criteria": ["完成变量练习"],
        },
    })


def make_document() -> dict[str, object]:
    """构造满足节点内容合同的最小三段式文档。"""
    return {
        "foundation": "变量用于保存和复用程序中的值。",
        "worked_example": {
            "explanation": "计算两次测量值的平均值。",
            "code": "first = 10\nsecond = 14\nprint((first + second) / 2)",
            "call_sequence": ["定义 first 和 second", "计算平均值", "打印结果"],
            "expected_output": "12.0",
        },
        "pitfalls_debug": "不要把数字写成字符串后直接参与数值计算。",
        "source_refs": [],
        "teaching_memory": {
            "key_concepts": ["变量", "表达式"],
            "common_mistakes": ["字符串与数字混用"],
            "assessment_targets": ["能解释变量赋值", "能计算表达式"],
        },
    }


def make_state() -> AgentRunExecutionState:
    """构造可用于模型请求的节点内容任务状态。"""
    return AgentRunExecutionState(
        run_id=uuid4(),
        owner_id=uuid4(),
        run_type="card_content_generate",
        target_type="plan_node",
        target_id=uuid4(),
        input_summary_json={},
        status="running",
        should_execute=True,
    )


def test_card_content_document_accepts_required_sections() -> None:
    """三段式公开内容和教学记忆齐全时应通过合同校验。"""
    document = CardContentDocument.model_validate(make_document())

    assert document.schema_version == "card_content.v1"
    assert document.worked_example["call_sequence"] == ["定义 first 和 second", "计算平均值", "打印结果"]


def test_card_content_document_normalizes_loose_model_fields() -> None:
    """模型返回宽松字段时应收敛为内部回写合同。"""
    document = CardContentDocument.from_json(orjson.dumps({"summary": "基础概念说明", "worked_example": "示例代码", "pitfalls": "检查输入", "teaching_memory": {"concepts": ["变量"]}}).decode())
    assert document.schema_version == "card_content.v1"
    assert document.worked_example["code"] == "# 请根据本章节目标补充示例代码"

def test_card_content_request_allows_model_to_decide_tavily_usage() -> None:
    """首轮节点内容请求应开放 Tavily 且保持 auto 工具策略。"""
    state = make_state()
    connection = ModelProviderConnection(
        owner_id=state.owner_id,
        connection_id=uuid4(),
        base_url="https://api.deepseek.com",
        model_id="deepseek-v4-flash",
        api_key=SecretStr("test-key"),
    )

    request = CardContentWorkflow._build_request(state, make_input(), connection)

    assert request.tool_choice == "auto"
    assert request.response_format == "json_object"
    assert request.tools[0].name == "tavily_search"
    assert request.messages[0].content is not None
    assert "worked_example" in request.messages[0].content


@pytest.mark.asyncio
async def test_node_tutor_registers_card_content_workflow() -> None:
    """NodeTutorAgent 必须能路由 card_content_generate，避免未注册错误。"""
    agent = NodeTutorAgent()

    assert "card_content_generate" in agent._workflows
