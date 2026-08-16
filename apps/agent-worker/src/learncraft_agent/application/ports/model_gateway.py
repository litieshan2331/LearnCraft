"""模型调用边界端口。

类：
- ModelGatewayError：向工作流暴露不含密钥或正文的稳定模型调用错误。
- ModelToolDefinition：模型可见的最小工具定义。
- ModelToolCall：Provider 返回的标准化工具调用。
- ModelMessage：独立于 Provider 的对话消息。
- ModelProviderConnection：已解密、仅在 Worker 内存中存在的默认模型连接。
- ModelCompletionRequest/Response：ModelGateway 的输入与输出契约。

协议：
- ModelGateway：OpenAI-compatible 等基础设施适配器必须实现的调用接口。
"""

from __future__ import annotations

from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator


class ModelGatewayError(RuntimeError):
    """表示可安全持久化或返回给 AgentRun 的模型调用错误。"""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class ModelToolDefinition(BaseModel):
    """表示只在当前模型请求中可见的函数工具 Schema。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1, max_length=500)
    parameters: dict[str, Any]


class ModelToolCall(BaseModel):
    """表示 Provider 响应中的单次函数工具调用。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=64)
    arguments_json: str = Field(min_length=1, max_length=16_384)


class ModelMessage(BaseModel):
    """表示 Provider 无关的 system、user、assistant 或 tool 消息。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = Field(default=None, max_length=64_000)
    reasoning_content: str | None = Field(default=None, max_length=512_000)
    tool_calls: tuple[ModelToolCall, ...] = ()
    tool_call_id: str | None = Field(default=None, max_length=255)
    name: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_message_shape(self) -> "ModelMessage":
        """确保工具调用与工具结果不会形成无法转换的 OpenAI 消息。"""
        if self.role != "assistant" and self.reasoning_content is not None:
            raise ValueError("only assistant messages can carry reasoning_content")
        if self.role == "tool":
            if not self.tool_call_id or not self.name or self.content is None:
                raise ValueError("tool 消息必须包含 tool_call_id、name 和 content。")
            if self.tool_calls:
                raise ValueError("tool 消息不能携带 tool_calls。")
        elif self.tool_call_id or self.name:
            raise ValueError("只有 tool 消息可以携带 tool_call_id 或 name。")
        elif self.role != "assistant" and self.tool_calls:
            raise ValueError("只有 assistant 消息可以携带 tool_calls。")
        elif self.role != "assistant" and self.content is None:
            raise ValueError("system 或 user 消息必须包含 content。")
        return self


class ModelProviderConnection(BaseModel):
    """表示已从 Web 内部接口取得并在 Worker 内存中解密的账户默认模型连接。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    owner_id: UUID
    connection_id: UUID
    base_url: str = Field(min_length=1, max_length=2_048)
    model_id: str = Field(min_length=1, max_length=255)
    api_key: SecretStr


class ModelUsage(BaseModel):
    """表示 Provider 公开返回的 token 用量；缺失字段按零处理。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class ModelCompletionRequest(BaseModel):
    """表示一次不流式的文本或工具调用模型请求。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_run_id: UUID
    connection: ModelProviderConnection
    messages: tuple[ModelMessage, ...] = Field(min_length=1)
    tools: tuple[ModelToolDefinition, ...] = ()
    tool_choice: Literal['auto', 'required', 'none'] = 'auto'
    thinking_mode: Literal['enabled'] = 'enabled'
    response_format: Literal['text', 'json_object'] = 'text'
    stream: Literal[True] = True


class ModelCompletionResponse(BaseModel):
    """表示 Provider 响应中已标准化的 assistant 消息与可选用量。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    message: ModelMessage
    usage: ModelUsage = ModelUsage()


class ModelGateway(Protocol):
    """定义工作流调用任意 OpenAI-compatible Provider 的最小能力。"""

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResponse:
        """完成一轮文本生成或返回模型请求执行的工具调用。"""
