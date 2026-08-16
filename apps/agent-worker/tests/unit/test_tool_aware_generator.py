'''ToolAwareGenerator 的工具上限回归测试。

测试职责：验证单次生成最多执行三次工具调用，达到上限后会关闭工具并让模型返回最终文本。
'''

from uuid import uuid4

import pytest
from pydantic import SecretStr

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelCompletionResponse,
    ModelMessage,
    ModelProviderConnection,
    ModelToolCall,
    ModelToolDefinition,
    ModelUsage,
)
from learncraft_agent.application.ports.tool_gateway import ToolExecutionResult
from learncraft_agent.application.services.tool_aware_generator import ToolAwareGenerator


class FakeModelGateway:
    '''每轮先请求一个工具，工具关闭后返回最终文本。'''

    def __init__(self) -> None:
        self.requests: list[ModelCompletionRequest] = []

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResponse:
        self.requests.append(request)
        if request.tools:
            return ModelCompletionResponse(
                message=ModelMessage(
                    role='assistant',
                    content='',
                    reasoning_content=f'thinking-{len(self.requests)}',
                    tool_calls=(ModelToolCall(id=f'call-{len(self.requests)}', name='fake_tool', arguments_json='{}'),),
                ),
                usage=ModelUsage(input_tokens=1, output_tokens=1),
            )
        return ModelCompletionResponse(
            message=ModelMessage(role='assistant', content='final'),
            usage=ModelUsage(input_tokens=1, output_tokens=1),
        )


class FakeToolGateway:
    '''记录实际工具执行次数并返回结构化成功结果。'''

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, tool_call: ModelToolCall) -> ToolExecutionResult:
        self.calls += 1
        return ToolExecutionResult(ok=True, code='OK', message='ok', data={'call': self.calls})


@pytest.mark.asyncio
async def test_tool_calls_are_capped_at_three() -> None:
    '''即使模型连续要求工具，也只执行三次。'''
    model = FakeModelGateway()
    tools = FakeToolGateway()
    request = ModelCompletionRequest(
        agent_run_id=uuid4(),
        connection=ModelProviderConnection(
            owner_id=uuid4(),
            connection_id=uuid4(),
            base_url='https://api.example.com',
            model_id='test-model',
            api_key=SecretStr('test-key'),
        ),
        messages=(ModelMessage(role='user', content='test'),),
        tools=(ModelToolDefinition(name='fake_tool', description='test', parameters={'type': 'object'}),),
    )

    result = await ToolAwareGenerator(model_gateway=model, tool_gateway=tools, max_tool_calls=3).generate(request)

    assert result.content == 'final'
    assert result.tool_call_count == 3
    assert tools.calls == 3
    assert model.requests[-1].tools == ()
    assert model.requests[-1].tool_choice == 'none'
    assert model.requests[1].messages[1].content == ''
    assert model.requests[1].messages[1].reasoning_content == 'thinking-1'
