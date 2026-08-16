"""Agent 工具执行边界端口。

类：
- ToolExecutionResult：可作为 tool 消息安全回填给模型的工具结果。

协议：
- ToolGateway：执行经白名单验证后的模型工具调用。
"""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from learncraft_agent.application.ports.model_gateway import ModelToolCall


class ToolExecutionResult(BaseModel):
    """表示成功或失败的工具结果，禁止携带密钥、请求头或原始异常。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: bool
    code: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=1_000)
    data: dict[str, Any] = Field(default_factory=dict)


class ToolGateway(Protocol):
    """定义模型工具调用到真实基础设施工具的受控执行入口。"""

    async def execute(self, tool_call: ModelToolCall) -> ToolExecutionResult:
        """执行白名单内的工具，预期将业务失败编码为 ToolExecutionResult。"""

