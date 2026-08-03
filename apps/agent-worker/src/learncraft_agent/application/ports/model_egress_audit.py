"""模型受控出网审计端口。

类：
- ModelEgressAuditEntry：描述一次允许、拦截或请求失败的模型出网审计事件。
- ModelEgressAuditWriter：定义审计事件的异步持久化契约。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

ModelEgressDecision = Literal["allowed", "blocked", "request_failed"]


@dataclass(frozen=True, slots=True)
class ModelEgressAuditEntry:
    """不含密钥、请求体和响应体的最小模型出网审计记录。"""

    owner_id: UUID
    model_connection_id: UUID
    agent_run_id: UUID | None
    host: str | None
    port: int | None
    decision: ModelEgressDecision
    reason_code: str


class ModelEgressAuditWriter(Protocol):
    """由基础设施实现的审计写入端口；生产调用失败时必须阻断模型出网。"""

    async def record(self, entry: ModelEgressAuditEntry) -> None:
        """持久化一次模型出网审计事件。"""
