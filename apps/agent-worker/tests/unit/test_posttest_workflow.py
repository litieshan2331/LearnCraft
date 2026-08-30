"""节点后测工作流单元测试。

测试：
- 验证后测只使用固定 CardContent 和 teaching_memory，不调用外部工具。
- 验证后测题目合同和 NodeTutorAgent 注册。
"""

from uuid import uuid4

import pytest
from pydantic import SecretStr, ValidationError

from learncraft_agent.application.ports.model_gateway import ModelProviderConnection
from learncraft_agent.application.services.node_tutor_agent import NodeTutorAgent
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState
from learncraft_agent.workflows.posttest_generate import PosttestGenerationInput, PosttestQuestionSet, PosttestWorkflow


def make_input() -> PosttestGenerationInput:
    """构造后测输入快照。"""
    return PosttestGenerationInput.model_validate({
        "topic": "Python 数据分析",
        "question_count": 5,
        "difficulty": "normal",
        "kind": "post_test",
        "plan_node_id": str(uuid4()),
        "source_card_content_id": str(uuid4()),
    })


def make_state() -> AgentRunExecutionState:
    """构造 posttest AgentRun 状态。"""
    return AgentRunExecutionState(
        run_id=uuid4(),
        owner_id=uuid4(),
        run_type="posttest_generate",
        target_type="plan_node",
        target_id=uuid4(),
        input_summary_json={},
        status="running",
        should_execute=True,
    )


def test_posttest_request_uses_fixed_content_without_tools() -> None:
    """后测请求必须关闭工具，只读取固定内容和教学记忆。"""
    state = make_state()
    connection = ModelProviderConnection(
        owner_id=state.owner_id,
        connection_id=uuid4(),
        base_url="https://api.deepseek.com",
        model_id="deepseek-v4-flash",
        api_key=SecretStr("test-key"),
    )
    request = PosttestWorkflow._build_request(
        state,
        make_input(),
        {
            "foundation": "变量保存程序运行过程中的值。",
            "worked_example": {"code": "x = 1"},
            "pitfalls_debug": "注意类型。",
            "teaching_memory": {"key_concepts": ["变量"]},
        },
        connection,
    )

    assert request.tools == ()
    assert request.tool_choice == "none"
    assert request.response_format == "json_object"


def test_posttest_question_set_validates_answer_key() -> None:
    """正确选项不在 options 中时拒绝题目。"""
    with pytest.raises(ValidationError):
        PosttestQuestionSet.model_validate({
            "questions": [{
                "prompt": "哪一个是变量？",
                "options": [{"key": "A", "text": "x"}, {"key": "B", "text": "常量"}],
                "answer_key": "C",
                "explanation": "C 不存在。",
            }] * 5,
        })


def test_node_tutor_registers_posttest_workflow() -> None:
    """NodeTutorAgent 必须注册 posttest_generate。"""
    agent = NodeTutorAgent()

    assert "posttest_generate" in agent._workflows
