"""前测与后测共用题集生成管线测试。

测试：
- QuestionSetGenerationPipeline：验证首轮失败后依次执行允许 Tavily 的修复和最终恢复。
"""

import json
from uuid import uuid4

import pytest
from pydantic import SecretStr

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelCompletionResponse,
    ModelMessage,
    ModelProviderConnection,
)
from learncraft_agent.application.ports.tool_gateway import ToolExecutionResult, ToolGateway
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import OpenAiCompatibleModelGateway
from learncraft_agent.workflows.question_set_generation import QuestionSetGenerationPipeline


class FakeModelGateway(OpenAiCompatibleModelGateway):
    """按顺序返回预置结果，并记录每次请求开放的工具。"""

    def __init__(self, responses: list[ModelCompletionResponse]) -> None:
        super().__init__(egress_client=None, request_max_retries=0)  # type: ignore[arg-type]
        self.responses = responses
        self.requests: list[ModelCompletionRequest] = []

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResponse:
        """返回下一个预置响应。"""
        self.requests.append(request)
        return self.responses.pop(0)


class FakeToolGateway(ToolGateway):
    """返回安全的空 Tavily 结果。"""

    async def execute(self, _tool_call):
        """模拟工具调用成功。"""
        return ToolExecutionResult(ok=True, code="OK", message="ok", data={})


def make_request() -> ModelCompletionRequest:
    """构造最小题集模型请求。"""
    return ModelCompletionRequest(
        agent_run_id=uuid4(),
        connection=ModelProviderConnection(
            owner_id=uuid4(),
            connection_id=uuid4(),
            base_url="https://api.deepseek.com",
            model_id="deepseek-v4-flash",
            api_key=SecretStr("test-key"),
        ),
        messages=(ModelMessage(role="system", content="Return JSON"), ModelMessage(role="user", content="生成题集")),
        response_format="json_object",
    )


def response(content: object) -> ModelCompletionResponse:
    """构造模型文本响应。"""
    return ModelCompletionResponse(message=ModelMessage(role="assistant", content=json.dumps(content, ensure_ascii=False)))


@pytest.mark.asyncio
async def test_pipeline_uses_tavily_on_repair_and_final_recovery() -> None:
    """首轮无工具失败后，修复和最终恢复都应开放 Tavily。"""
    invalid = {"schema_version": "wrong", "questions": []}
    valid = {
        "schema_version": "assessment.single_choice.v1",
        "questions": [
            {
                "prompt": f"题目 {index}",
                "options": [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                "answer_key": "A",
                "explanation": "解析",
                "skill_tags": [],
                "max_score": 1,
            }
            for index in range(5)
        ],
    }
    gateway = FakeModelGateway([response(invalid), response(invalid), response(valid)])

    result = await QuestionSetGenerationPipeline(
        model_gateway=gateway,
        tool_gateway=FakeToolGateway(),
        max_tool_calls=6,
    ).generate(
        make_request(),
        expected_question_count=5,
        repair_instruction="修复 JSON",
        final_instruction="最终恢复 JSON",
        repair_with_tavily=True,
        final_with_tavily=True,
    )

    assert result.recovery_stage == "tavily_recovery"
    assert len(result.question_set.questions) == 5
    assert gateway.requests[0].tools == ()
    assert gateway.requests[1].tools
    assert gateway.requests[2].tools
