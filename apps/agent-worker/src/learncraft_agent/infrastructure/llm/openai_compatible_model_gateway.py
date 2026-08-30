"""OpenAI-compatible Provider 的受控 ModelGateway 实现。

类：
- OpenAiCompatibleModelGateway：通过 SafeModelEgressClient 发起文本、结构化输出和工具调用请求。
- _validation_paths：提取结构化校验字段路径，不记录模型原文。

函数：
- 将 Provider 无关消息和工具定义转换为 Chat Completions 载荷。
- 解析并验证 Provider 响应，保留工具调用和 token 用量。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any, TypeVar

import orjson
from pydantic import BaseModel, ValidationError

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelCompletionResponse,
    ModelGatewayError,
    ModelMessage,
    ModelToolCall,
    ModelUsage,
)
from learncraft_agent.infrastructure.llm.egress_policy import ModelEgressPolicyError
from learncraft_agent.infrastructure.llm.safe_egress_client import (
    ModelEgressRequestError,
    SafeModelEgressClient,
)

StructuredOutput = TypeVar("StructuredOutput", bound=BaseModel)
logger = logging.getLogger(__name__)


class OpenAiCompatibleModelGateway:
    """将账户默认模型连接转换为受审计、受 SSRF 防护的 Chat Completions 调用。"""

    def __init__(
        self,
        *,
        egress_client: SafeModelEgressClient,
        request_max_retries: int,
    ) -> None:
        self._egress_client = egress_client
        self._request_max_retries = request_max_retries

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResponse:
        """执行一轮模型请求；临时网络或 Provider 故障最多额外重试两次。"""
        payload = self._build_payload(request)

        for attempt in range(self._request_max_retries + 1):
            try:
                response = await self._egress_client.post_openai_compatible_sse(
                    owner_id=request.connection.owner_id,
                    model_connection_id=request.connection.connection_id,
                    agent_run_id=request.agent_run_id,
                    base_url=request.connection.base_url,
                    api_key=request.connection.api_key.get_secret_value(),
                    endpoint_segments=("chat", "completions"),
                    payload=payload,
                )
                return self._parse_stream_completion_response(response.events)
            except ModelEgressPolicyError as error:
                raise ModelGatewayError(error.code, str(error), retryable=False) from error
            except ModelEgressRequestError as error:
                if error.retryable and attempt < self._request_max_retries:
                    await asyncio.sleep(0.5 * (2**attempt))
                    continue
                raise self._to_gateway_error(error, has_tools=bool(request.tools)) from error

        raise AssertionError("模型重试循环不应在没有返回或抛出时结束。")

    async def complete_structured(
        self,
        request: ModelCompletionRequest,
        output_type: type[StructuredOutput],
        *,
        repair_instruction: str | None = None,
    ) -> StructuredOutput:
        """按提示词和 Pydantic 校验获取 JSON，格式无效时仅执行一次修复请求。"""
        structured_request = request.model_copy(update={'response_format': 'json_object'})
        response = await self.complete(structured_request)
        validation_paths: list[str] = []
        for repair_attempt in range(2):
            if response.message.tool_calls or response.message.content is None:
                raise ModelGatewayError(
                    "MODEL_STRUCTURED_OUTPUT_INVALID",
                    "模型没有返回可校验的结构化文本结果。",
                    retryable=False,
                    validation_paths=("response.content_missing",),
                )
            try:
                return output_type.model_validate_json(self._extract_json_text(response.message.content))
            except (ValidationError, ValueError) as error:
                validation_paths = _validation_paths(error)
                if repair_attempt == 1:
                    path_summary = ", ".join(validation_paths[:8]) or "response.json"
                    raise ModelGatewayError(
                        "MODEL_STRUCTURED_OUTPUT_INVALID",
                        f"模型返回内容不符合预期结构。校验路径: {path_summary}",
                        retryable=False,
                        validation_paths=tuple(validation_paths),
                    )
                repair_message = ModelMessage(
                    role="system",
                    content=repair_instruction or ("上一轮输出不符合要求。请基于已有上下文重新输出严格合法的 JSON，" "不要使用 Markdown 代码块、解释文字或额外字段。"),
                )
                response = await self.complete(
                    structured_request.model_copy(
                        update={
                            "messages": request.messages
                            + (response.message, repair_message),
                            "tools": (),
                            "tool_choice": "none",
                        },
                    ),
                )

        raise AssertionError("结构化输出修复循环不应在没有返回或抛出时结束。")

    @staticmethod
    def _build_payload(request: ModelCompletionRequest) -> dict[str, Any]:
        """将领域消息和局部工具白名单转换为 OpenAI Chat Completions 请求体。"""
        payload: dict[str, Any] = {
            "model": request.connection.model_id,
            "messages": [
                OpenAiCompatibleModelGateway._to_provider_message(message)
                for message in request.messages
            ],
        }
        payload['stream'] = request.stream
        payload['stream_options'] = {'include_usage': True}
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
            payload['tool_choice'] = request.tool_choice
        if OpenAiCompatibleModelGateway._uses_deepseek_v4(request):
            payload['thinking'] = {'type': request.thinking_mode}
        if request.response_format == 'json_object':
            OpenAiCompatibleModelGateway._ensure_json_prompt(payload["messages"])
            payload['response_format'] = {'type': 'json_object'}
        return payload

    @staticmethod
    def _ensure_json_prompt(messages: list[dict[str, Any]]) -> None:
        """为要求小写 json 提示词的兼容 Provider 注入最小格式提示。"""
        for message in messages:
            content = message.get("content")
            if message.get("role") in {"system", "user"} and isinstance(content, str):
                if "json" not in content:
                    message["content"] = f"{content}\nReturn a valid json object."
                return
        messages.insert(0, {"role": "system", "content": "Return a valid json object."})

    @staticmethod
    def _uses_deepseek_v4(request: ModelCompletionRequest) -> bool:
        '''仅为 DeepSeek V4 请求显式开启思考模式，避免向其他兼容 Provider 注入私有参数。'''
        return request.connection.model_id.strip().lower().startswith('deepseek-v4-')

    @staticmethod
    def _to_provider_message(message: ModelMessage) -> dict[str, Any]:
        """转换单条标准消息，且只使用 OpenAI-compatible 通用字段。"""
        provider_message: dict[str, Any] = {"role": message.role}
        if message.content is not None:
            provider_message["content"] = message.content
        elif message.role == "assistant" and message.tool_calls:
            provider_message["content"] = ""
        if message.reasoning_content is not None:
            provider_message["reasoning_content"] = message.reasoning_content
        if message.tool_calls:
            provider_message["tool_calls"] = [
                {
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.name,
                        "arguments": tool_call.arguments_json,
                    },
                }
                for tool_call in message.tool_calls
            ]
        if message.role == "tool":
            provider_message["tool_call_id"] = message.tool_call_id
            provider_message["name"] = message.name
        return provider_message

    @staticmethod
    def _parse_completion_response(payload: Mapping[str, Any]) -> ModelCompletionResponse:
        """解析最小 Chat Completions 响应，拒绝缺少 choices 或 tool 参数的结果。"""
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回了不符合 Chat Completions 契约的响应。",
                retryable=False,
            )
        raw_message = choices[0].get("message")
        if not isinstance(raw_message, Mapping):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务响应缺少 assistant 消息。",
                retryable=False,
            )

        raw_content = raw_message.get("content")
        if raw_content is not None and not isinstance(raw_content, str):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回了不支持的消息内容格式。",
                retryable=False,
            )

        raw_reasoning_content = raw_message.get("reasoning_content")
        if raw_reasoning_content is not None and not isinstance(raw_reasoning_content, str):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回了不支持的 reasoning_content 格式。",
                retryable=False,
            )

        raw_tool_calls = raw_message.get("tool_calls", [])
        if not isinstance(raw_tool_calls, list):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回了不支持的工具调用格式。",
                retryable=False,
            )
        tool_calls = tuple(
            OpenAiCompatibleModelGateway._parse_tool_call(raw_tool_call)
            for raw_tool_call in raw_tool_calls
        )
        if raw_content is None and not tool_calls:
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务既未返回文本也未返回工具调用。",
                retryable=False,
            )

        raw_usage = payload.get("usage")
        usage = ModelUsage(
            input_tokens=OpenAiCompatibleModelGateway._usage_value(
                raw_usage,
                "prompt_tokens",
            ),
            output_tokens=OpenAiCompatibleModelGateway._usage_value(
                raw_usage,
                "completion_tokens",
            ),
        )
        return ModelCompletionResponse(
            message=ModelMessage(
                role="assistant",
                content="" if raw_content is None and tool_calls else raw_content,
                reasoning_content=raw_reasoning_content,
                tool_calls=tool_calls,
            ),
            usage=usage,
        )

    @staticmethod
    def _parse_stream_completion_response(
        events: tuple[Mapping[str, Any], ...],
    ) -> ModelCompletionResponse:
        '''聚合 OpenAI data-only SSE 的文本、思考内容、工具参数和流尾用量。'''
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        raw_usage: object = None

        for event in events:
            event_usage = event.get('usage')
            if isinstance(event_usage, Mapping):
                raw_usage = event_usage
            raw_choices = event.get('choices', [])
            if not isinstance(raw_choices, list):
                raise ModelGatewayError(
                    'MODEL_PROVIDER_RESPONSE_INVALID',
                    '模型服务返回了不支持的 SSE choices 格式。',
                    retryable=False,
                )
            for raw_choice in raw_choices:
                if not isinstance(raw_choice, Mapping):
                    raise ModelGatewayError(
                        'MODEL_PROVIDER_RESPONSE_INVALID',
                        '模型服务返回了不支持的 SSE choice 格式。',
                        retryable=False,
                    )
                raw_index = raw_choice.get('index', 0)
                if raw_index != 0:
                    continue
                finish_reason = raw_choice.get('finish_reason')
                if finish_reason == 'length':
                    raise ModelGatewayError(
                        'MODEL_PROVIDER_RESPONSE_TRUNCATED',
                        '模型输出在完成前被截断。',
                        retryable=False,
                    )
                raw_delta = raw_choice.get('delta', {})
                if not isinstance(raw_delta, Mapping):
                    raise ModelGatewayError(
                        'MODEL_PROVIDER_RESPONSE_INVALID',
                        '模型服务返回了不支持的 SSE delta 格式。',
                        retryable=False,
                    )
                raw_content = raw_delta.get('content')
                if raw_content is not None:
                    if not isinstance(raw_content, str):
                        raise ModelGatewayError(
                            'MODEL_PROVIDER_RESPONSE_INVALID',
                            '模型服务返回了不支持的流式文本格式。',
                            retryable=False,
                        )
                    content_parts.append(raw_content)
                raw_reasoning_content = raw_delta.get('reasoning_content')
                if raw_reasoning_content is not None:
                    if not isinstance(raw_reasoning_content, str):
                        raise ModelGatewayError(
                            'MODEL_PROVIDER_RESPONSE_INVALID',
                            '模型服务返回了不支持的流式 reasoning_content 格式。',
                            retryable=False,
                        )
                    reasoning_parts.append(raw_reasoning_content)
                raw_tool_calls = raw_delta.get('tool_calls', [])
                if not isinstance(raw_tool_calls, list):
                    raise ModelGatewayError(
                        'MODEL_PROVIDER_RESPONSE_INVALID',
                        '模型服务返回了不支持的流式工具调用格式。',
                        retryable=False,
                    )
                for fallback_index, raw_tool_call in enumerate(raw_tool_calls):
                    OpenAiCompatibleModelGateway._merge_stream_tool_call(
                        tool_calls,
                        raw_tool_call,
                        fallback_index,
                    )

        raw_message: dict[str, Any] = {
            'content': ''.join(content_parts) if content_parts else None,
            'reasoning_content': ''.join(reasoning_parts) if reasoning_parts else None,
            'tool_calls': [tool_calls[index] for index in sorted(tool_calls)],
        }
        return OpenAiCompatibleModelGateway._parse_completion_response(
            {'choices': [{'message': raw_message}], 'usage': raw_usage},
        )

    @staticmethod
    def _merge_stream_tool_call(
        aggregated_tool_calls: dict[int, dict[str, Any]],
        raw_tool_call: object,
        fallback_index: int,
    ) -> None:
        '''按 OpenAI 流式 index 合并同一工具调用被分片返回的字段。'''
        if not isinstance(raw_tool_call, Mapping):
            raise ModelGatewayError(
                'MODEL_PROVIDER_RESPONSE_INVALID',
                '模型服务返回了不支持的流式工具调用格式。',
                retryable=False,
            )
        raw_index = raw_tool_call.get('index', fallback_index)
        if not isinstance(raw_index, int) or raw_index < 0:
            raise ModelGatewayError(
                'MODEL_PROVIDER_RESPONSE_INVALID',
                '模型服务返回了无效的流式工具调用索引。',
                retryable=False,
            )
        tool_call = aggregated_tool_calls.setdefault(
            raw_index,
            {'function': {'arguments': ''}},
        )
        raw_id = raw_tool_call.get('id')
        if raw_id is not None:
            if not isinstance(raw_id, str):
                raise ModelGatewayError(
                    'MODEL_PROVIDER_RESPONSE_INVALID',
                    '模型服务返回了无效的流式工具调用标识。',
                    retryable=False,
                )
            tool_call['id'] = raw_id
        raw_function = raw_tool_call.get('function')
        if raw_function is None:
            return
        if not isinstance(raw_function, Mapping):
            raise ModelGatewayError(
                'MODEL_PROVIDER_RESPONSE_INVALID',
                '模型服务返回了无效的流式工具函数信息。',
                retryable=False,
            )
        function = tool_call['function']
        raw_name = raw_function.get('name')
        if raw_name is not None:
            if not isinstance(raw_name, str):
                raise ModelGatewayError(
                    'MODEL_PROVIDER_RESPONSE_INVALID',
                    '模型服务返回了无效的流式工具函数名。',
                    retryable=False,
                )
            function['name'] = raw_name
        raw_arguments = raw_function.get('arguments')
        if raw_arguments is not None:
            if not isinstance(raw_arguments, str):
                raise ModelGatewayError(
                    'MODEL_PROVIDER_RESPONSE_INVALID',
                    '模型服务返回了无效的流式工具参数。',
                    retryable=False,
                )
            function['arguments'] += raw_arguments

    @staticmethod
    def _parse_tool_call(raw_tool_call: object) -> ModelToolCall:
        """解析一条函数工具调用，同时保留原始 JSON 参数供 ToolGateway 再校验。"""
        if not isinstance(raw_tool_call, Mapping):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回了不支持的工具调用格式。",
                retryable=False,
            )
        raw_id = raw_tool_call.get("id")
        function = raw_tool_call.get("function")
        if not isinstance(raw_id, str) or not isinstance(function, Mapping):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回的工具调用缺少标识或函数信息。",
                retryable=False,
            )
        raw_name = function.get("name")
        raw_arguments = function.get("arguments")
        if not isinstance(raw_name, str):
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回的工具调用缺少函数名。",
                retryable=False,
            )
        if isinstance(raw_arguments, Mapping):
            arguments_json = orjson.dumps(raw_arguments).decode("utf-8")
        elif isinstance(raw_arguments, str):
            arguments_json = raw_arguments
        else:
            raise ModelGatewayError(
                "MODEL_PROVIDER_RESPONSE_INVALID",
                "模型服务返回的工具调用参数格式不正确。",
                retryable=False,
            )
        return ModelToolCall(id=raw_id, name=raw_name, arguments_json=arguments_json)

    @staticmethod
    def _usage_value(raw_usage: object, field_name: str) -> int:
        """读取可选 usage 字段，缺失或不合规时按零处理。"""
        if not isinstance(raw_usage, Mapping):
            return 0
        value = raw_usage.get(field_name)
        return value if isinstance(value, int) and value >= 0 else 0

    @staticmethod
    def _extract_json_text(content: str) -> str:
        """兼容少数 Provider 返回的 Markdown JSON 代码块，但不接受附加解释。"""
        normalized = content.strip()
        if normalized.startswith("```json") and normalized.endswith("```"):
            return normalized[7:-3].strip()
        if normalized.startswith("```") and normalized.endswith("```"):
            return normalized[3:-3].strip()
        return normalized

    @staticmethod
    def _to_gateway_error(
        error: ModelEgressRequestError,
        *,
        has_tools: bool,
    ) -> ModelGatewayError:
        """将受控出网错误映射为工作流可处理的稳定模型错误。"""
        if has_tools and error.code in {
            "MODEL_PROVIDER_HTTP_400",
            "MODEL_PROVIDER_HTTP_404",
            "MODEL_PROVIDER_HTTP_405",
            "MODEL_PROVIDER_HTTP_422",
        }:
            logger.warning(
                'model_tool_request_rejected provider_error_code=%s provider_error_message=%s',
                error.provider_error_code,
                error.provider_error_message,
            )
            return ModelGatewayError(
                "MODEL_TOOL_CALL_REQUEST_REJECTED",
                "模型服务拒绝了工具调用请求，请检查 Worker 日志中的脱敏 Provider 诊断。",
                retryable=False,
            )
        return ModelGatewayError(error.code, str(error), retryable=error.retryable)


def _validation_paths(error: ValidationError | ValueError) -> list[str]:
    """只提取结构化校验字段路径，不记录模型输出正文或敏感值。"""
    if isinstance(error, ValidationError):
        paths: list[str] = []
        for item in error.errors():
            location = item.get("loc", ())
            path = ".".join(str(part) for part in location)
            if path and path not in paths:
                paths.append(path)
        return paths
    return ["response.json"]
