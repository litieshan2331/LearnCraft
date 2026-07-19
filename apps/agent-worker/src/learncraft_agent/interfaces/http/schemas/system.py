"""Worker 系统接口的 Pydantic DTO。

类：
- ServiceStatusResponse：与跨语言 OpenAPI 契约对齐的服务健康与版本响应。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ServiceStatusResponse(BaseModel):
    """公开且不含敏感信息的 Agent Worker 服务状态。"""

    model_config = ConfigDict(extra="forbid")

    status: Literal["ok", "degraded"] = "ok"
    service: Literal["agent-worker"] = "agent-worker"
    version: str = Field(min_length=1, max_length=100)
    git_sha: str = Field(min_length=1, max_length=100)
