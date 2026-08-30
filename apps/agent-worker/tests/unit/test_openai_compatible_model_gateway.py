'''OpenAI-compatible 模型网关的 DeepSeek V4 兼容性测试。

测试职责：
- 验证 DeepSeek V4 请求固定携带 thinking enabled、SSE、JSON Output、工具定义和 auto 工具选择；
- 验证工具调用的 assistant 消息会回放 content 与 reasoning_content；
- 验证模型响应中的 reasoning_content 会被保留给下一轮工具循环。
'''

from uuid import uuid4

import pytest
from pydantic import BaseModel, SecretStr

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelCompletionResponse,
    ModelGatewayError,
    ModelMessage,
    ModelProviderConnection,
    ModelToolCall,
    ModelToolDefinition,
)
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import (
    OpenAiCompatibleModelGateway,
)


def _deepseek_request() -> ModelCompletionRequest:
    '''构造包含一轮 Tavily 工具调用历史的 DeepSeek V4 请求。'''
    return ModelCompletionRequest(
        agent_run_id=uuid4(),
        connection=ModelProviderConnection(
            owner_id=uuid4(),
            connection_id=uuid4(),
            base_url='https://api.deepseek.com',
            model_id='deepseek-v4-flash',
            api_key=SecretStr('test-key'),
        ),
        messages=(
            ModelMessage(role='user', content='查询 DeepSeek V4 的工具调用文档'),
            ModelMessage(
                role='assistant',
                content='',
                reasoning_content='需要先通过 tavily_search 检索官方文档。',
                tool_calls=(
                    ModelToolCall(
                        id='call-1',
                        name='tavily_search',
                        arguments_json='{}',
                    ),
                ),
            ),
            ModelMessage(
                role='tool',
                tool_call_id='call-1',
                name='tavily_search',
                content='{}',
            ),
        ),
        tools=(
            ModelToolDefinition(
                name='tavily_search',
                description='检索网页。',
                parameters={'type': 'object'},
            ),
        ),
        tool_choice='auto',
        response_format='json_object',
    )


def test_deepseek_v4_payload_keeps_thinking_auto_tools_and_reasoning() -> None:
    '''DeepSeek V4 的工具请求必须保持思考模式、可选工具和推理内容回放。'''
    payload = OpenAiCompatibleModelGateway._build_payload(_deepseek_request())

    assert payload['thinking'] == {'type': 'enabled'}
    assert payload['stream'] is True
    assert payload['stream_options'] == {'include_usage': True}
    assert payload['response_format'] == {'type': 'json_object'}
    assert "json" in payload['messages'][0]['content']

    assert payload['tool_choice'] == 'auto'
    assert payload['tools'][0]['function']['name'] == 'tavily_search'
    assert payload['messages'][1]['content'] == ''
    assert payload['messages'][1]['reasoning_content'] == '需要先通过 tavily_search 检索官方文档。'


def test_completion_response_preserves_reasoning_content_for_tool_history() -> None:
    '''模型返回工具调用时，网关必须保留 reasoning_content 和空 content。'''
    response = OpenAiCompatibleModelGateway._parse_completion_response(
        {
            'choices': [
                {
                    'message': {
                        'content': None,
                        'reasoning_content': '先联网检索，再综合证据。',
                        'tool_calls': [
                            {
                                'id': 'call-1',
                                'function': {
                                    'name': 'tavily_search',
                                    'arguments': {},
                                },
                            },
                        ],
                    },
                },
            ],
        },
    )

    assert response.message.content == ''
    assert response.message.reasoning_content == '先联网检索，再综合证据。'
    assert response.message.tool_calls[0].name == 'tavily_search'


def test_stream_response_aggregates_reasoning_content_tool_calls_and_usage() -> None:
    '''SSE 分片必须聚合为可回放的完整 assistant 消息和流尾用量。'''
    response = OpenAiCompatibleModelGateway._parse_stream_completion_response(
        (
            {
                'choices': [
                    {
                        'index': 0,
                        'delta': {
                            'reasoning_content': '需要检索',
                            'tool_calls': [
                                {
                                    'index': 0,
                                    'id': 'call-1',
                                    'function': {'name': 'tavily_search', 'arguments': 'first'},
                                },
                            ],
                        },
                    },
                ],
            },
            {
                'choices': [
                    {
                        'index': 0,
                        'delta': {
                            'content': '',
                            'tool_calls': [
                                {
                                    'index': 0,
                                    'function': {'arguments': '-second'},
                                },
                            ],
                        },
                        'finish_reason': 'tool_calls',
                    },
                ],
            },
            {
                'choices': [],
                'usage': {'prompt_tokens': 7, 'completion_tokens': 11},
            },
        ),
    )

    assert response.message.content == ''
    assert response.message.reasoning_content == '需要检索'
    assert response.message.tool_calls[0].id == 'call-1'
    assert response.message.tool_calls[0].arguments_json == 'first-second'
    assert response.usage.input_tokens == 7
    assert response.usage.output_tokens == 11

class _TinyStructuredOutput(BaseModel):
    """用于验证结构化错误路径的最小输出合同。"""

    value: int


class _FakeStructuredGateway(OpenAiCompatibleModelGateway):
    """依次返回两次非法结构化结果，不发起真实网络请求。"""

    def __init__(self, responses: list[ModelCompletionResponse]) -> None:
        super().__init__(egress_client=None, request_max_retries=0)  # type: ignore[arg-type]
        self._responses = responses

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResponse:
        """返回预置响应，模拟首轮和修复轮均校验失败。"""
        return self._responses.pop(0)


def test_complete_structured_records_only_validation_paths() -> None:
    """结构化失败必须暴露字段路径，但不得把模型正文写入错误摘要。"""
    responses = [
        ModelCompletionResponse(message=ModelMessage(role='assistant', content='{"value":"bad"}')),
        ModelCompletionResponse(message=ModelMessage(role='assistant', content='{"value":"still-bad"}')),
    ]
    gateway = _FakeStructuredGateway(responses)

    with pytest.raises(ModelGatewayError) as captured:
        import asyncio
        asyncio.run(gateway.complete_structured(_deepseek_request(), _TinyStructuredOutput))

    error = captured.value
    assert error.code == 'MODEL_STRUCTURED_OUTPUT_INVALID'
    assert error.validation_paths == ('value',)
    assert '校验路径: value' in str(error)
    assert 'still-bad' not in str(error)