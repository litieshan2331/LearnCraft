"""支持受控工具调用的模型生成编排服务。

类：
- ToolAwareGenerationResult：最终模型文本、累计用量和执行工具次数。
- ToolAwareGenerator：在最多三次工具调用内将工具结果或失败原因回填给模型。
"""

from __future__ import annotations

import orjson
from pydantic import BaseModel, ConfigDict, Field

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelGateway,
    ModelGatewayError,
    ModelMessage,
    ModelUsage,
)
from learncraft_agent.application.ports.tool_gateway import ToolExecutionResult, ToolGateway


class ToolAwareGenerationResult(BaseModel):
    """表示工具循环结束后的最终回答与聚合 token 用量。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    content: str = Field(min_length=1)
    usage: ModelUsage
    tool_call_count: int = Field(ge=0)


class ToolAwareGenerator:
    """将 ModelGateway 与固定白名单 ToolGateway 组合为有上限的 ReAct 基础循环。"""

    def __init__(
        self,
        *,
        model_gateway: ModelGateway,
        tool_gateway: ToolGateway,
        max_tool_calls: int,
    ) -> None:
        self._model_gateway = model_gateway
        self._tool_gateway = tool_gateway
        self._max_tool_calls = max_tool_calls

    async def generate(self, request: ModelCompletionRequest) -> ToolAwareGenerationResult:
        """执行模型和工具循环；工具失败会编码为 tool 消息而不是直接隐藏。"""
        messages = request.messages
        usage = ModelUsage()
        tool_call_count = 0
        current_request = request

        while True:
            response = await self._model_gateway.complete(
                current_request.model_copy(update={"messages": messages}),
            )
            usage = ModelUsage(
                input_tokens=usage.input_tokens + response.usage.input_tokens,
                output_tokens=usage.output_tokens + response.usage.output_tokens,
            )
            assistant_message = response.message
            if not assistant_message.tool_calls:
                if not assistant_message.content:
                    raise ModelGatewayError(
                        "MODEL_PROVIDER_RESPONSE_INVALID",
                        "模型没有返回最终文本内容。",
                        retryable=False,
                    )
                return ToolAwareGenerationResult(
                    content=assistant_message.content,
                    usage=usage,
                    tool_call_count=tool_call_count,
                )

            messages += (assistant_message,)
            remaining_calls = self._max_tool_calls - tool_call_count
            tool_messages: list[ModelMessage] = []
            for index, tool_call in enumerate(assistant_message.tool_calls):
                if index >= remaining_calls:
                    result = ToolExecutionResult(
                        ok=False,
                        code="TOOL_CALL_LIMIT_REACHED",
                        message="本次任务已达到联网工具调用上限，请基于已有资料继续完成回答。",
                    )
                else:
                    result = await self._tool_gateway.execute(tool_call)
                    tool_call_count += 1
                tool_messages.append(
                    ModelMessage(
                        role="tool",
                        tool_call_id=tool_call.id,
                        name=tool_call.name,
                        content=orjson.dumps(result.model_dump(mode="json")).decode("utf-8"),
                    ),
                )
            messages += tuple(tool_messages)

            if tool_call_count >= self._max_tool_calls:
                current_request = request.model_copy(update={'tools': (), 'tool_choice': 'none'})
            else:
                current_request = request.model_copy(update={'tool_choice': 'auto'})
