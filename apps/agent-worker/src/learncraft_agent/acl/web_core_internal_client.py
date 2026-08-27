"""Worker 访问 Web 私有内部接口的反腐层。

类：
- CoreInternalClientError：内部服务通信或默认模型连接缺失的稳定错误。
- DefaultModelConnectionEnvelope：Web 返回的默认模型连接密文契约。
- WebCoreInternalClient：以共享服务密钥读取单个 AgentRun 的账户默认连接。
"""

from __future__ import annotations

from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from learncraft_agent.infrastructure.llm.credential_decryptor import EncryptedModelCredential


class CoreInternalClientError(RuntimeError):
    """表示不会泄露内部地址、密钥或响应正文的 Web 内部接口错误。"""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class DefaultModelConnectionEnvelope(BaseModel):
    """表示 Web 已按 AgentRun 所有者筛选后的默认模型连接密文。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    owner_id: UUID
    connection_id: UUID
    base_url: str = Field(min_length=1, max_length=2_048)
    model_id: str = Field(min_length=1, max_length=255)
    credential: EncryptedModelCredential


class PersistedAssessmentEnvelope(BaseModel):
    """表示 Web 已幂等持久化题集后的最小结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    assessment_id: UUID
    status: str = Field(min_length=1, max_length=30)
    question_count: int = Field(ge=1, le=20)



class PersistedLearningPlanEnvelope(BaseModel):
    """表示 Web 已幂等持久化学习路线后的最小结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    learning_plan_id: UUID
    node_count: int = Field(ge=6, le=12)

class PersistedCardContentEnvelope(BaseModel):
    """表示 Web 已幂等持久化节点内容后的最小结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    card_content_id: UUID
    status: str = Field(min_length=1, max_length=20)
class WebCoreInternalClient:
    """只允许 Celery Worker 通过私网读取 AgentRun 所需的默认模型连接。"""

    def __init__(
        self,
        *,
        base_url: str,
        internal_service_secret: SecretStr | None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._internal_service_secret = internal_service_secret

    async def persist_assessment(
        self,
        *,
        agent_run_id: UUID,
        payload: dict[str, object],
    ) -> PersistedAssessmentEnvelope:
        """通过内部鉴权把已校验题集交给 Web 事务持久化，重复调用保持幂等。"""
        if self._internal_service_secret is None:
            raise CoreInternalClientError(
                "INTERNAL_SERVICE_SECRET_MISSING",
                "Worker 与 Web 的内部服务密钥尚未配置。",
                retryable=False,
            )
        url = f"{self._base_url}/agent-runs/{agent_run_id}/assessment-result"
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "X-LearnCraft-Internal-Secret": self._internal_service_secret.get_secret_value(),
                        "User-Agent": "LearnCraft-Agent/0.1",
                    },
                    json=payload,
                )
        except httpx.HTTPError as error:
            raise CoreInternalClientError("CORE_INTERNAL_UNAVAILABLE", "Web 内部服务暂时不可用。", retryable=True) from error
        if response.status_code == 404:
            raise CoreInternalClientError("AGENT_RUN_NOT_FOUND", "待持久化的 AgentRun 不存在或类型不匹配。", retryable=False)
        if response.status_code in {401, 403}:
            raise CoreInternalClientError("CORE_INTERNAL_AUTH_FAILED", "Worker 无法通过 Web 内部服务鉴权。", retryable=False)
        if response.status_code >= 500:
            raise CoreInternalClientError("CORE_INTERNAL_UNAVAILABLE", "Web 内部服务暂时不可用。", retryable=True)
        if not 200 <= response.status_code < 300:
            raise CoreInternalClientError("ASSESSMENT_PERSISTENCE_REJECTED", "Web 拒绝了题集持久化请求。", retryable=False)
        try:
            return PersistedAssessmentEnvelope.model_validate(response.json())
        except (ValidationError, ValueError) as error:
            raise CoreInternalClientError("CORE_INTERNAL_RESPONSE_INVALID", "Web 内部服务返回了不符合契约的数据。", retryable=False) from error

    async def persist_learning_plan(
        self,
        *,
        agent_run_id: UUID,
        payload: dict[str, object],
    ) -> PersistedLearningPlanEnvelope:
        """通过内部鉴权持久化已校验的学习路线和前置依赖。"""
        if self._internal_service_secret is None:
            raise CoreInternalClientError(
                "INTERNAL_SERVICE_SECRET_MISSING",
                "Worker 与 Web 的内部服务密钥尚未配置。",
                retryable=False,
            )

        url = f"{self._base_url}/agent-runs/{agent_run_id}/plan-result"
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "X-LearnCraft-Internal-Secret": self._internal_service_secret.get_secret_value(),
                        "User-Agent": "LearnCraft-Agent/0.1",
                    },
                    json=payload,
                )
        except httpx.HTTPError as error:
            raise CoreInternalClientError(
                "CORE_INTERNAL_UNAVAILABLE",
                "Web 内部服务暂时不可用。",
                retryable=True,
            ) from error

        if response.status_code == 404:
            raise CoreInternalClientError(
                "AGENT_RUN_NOT_FOUND",
                "待持久化的 AgentRun 不存在或类型不匹配。",
                retryable=False,
            )
        if response.status_code in {401, 403}:
            raise CoreInternalClientError(
                "CORE_INTERNAL_AUTH_FAILED",
                "Worker 无法通过 Web 内部服务鉴权。",
                retryable=False,
            )
        if response.status_code >= 500:
            raise CoreInternalClientError(
                "CORE_INTERNAL_UNAVAILABLE",
                "Web 内部服务暂时不可用。",
                retryable=True,
            )
        if not 200 <= response.status_code < 300:
            raise CoreInternalClientError(
                "PLAN_PERSISTENCE_REJECTED",
                "Web 拒绝了学习路线持久化请求。",
                retryable=False,
            )

        try:
            return PersistedLearningPlanEnvelope.model_validate(response.json())
        except (ValidationError, ValueError) as error:
            raise CoreInternalClientError(
                "CORE_INTERNAL_RESPONSE_INVALID",
                "Web 内部服务返回了不符合契约的数据。",
                retryable=False,
            ) from error
    async def persist_card_content(
        self,
        *,
        agent_run_id: UUID,
        payload: dict[str, object],
    ) -> PersistedCardContentEnvelope:
        """通过内部鉴权持久化已校验节点内容。"""
        if self._internal_service_secret is None:
            raise CoreInternalClientError(
                "INTERNAL_SERVICE_SECRET_MISSING",
                "Worker 与 Web 的内部服务密钥尚未配置。",
                retryable=False,
            )
        url = f"{self._base_url}/agent-runs/{agent_run_id}/card-content-result"
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "X-LearnCraft-Internal-Secret": self._internal_service_secret.get_secret_value(),
                        "User-Agent": "LearnCraft-Agent/0.1",
                    },
                    json=payload,
                )
        except httpx.HTTPError as error:
            raise CoreInternalClientError("CORE_INTERNAL_UNAVAILABLE", "Web 内部服务暂时不可用。", retryable=True) from error
        if response.status_code == 404:
            raise CoreInternalClientError("AGENT_RUN_NOT_FOUND", "待持久化的 AgentRun 不存在或类型不匹配。", retryable=False)
        if response.status_code in {401, 403}:
            raise CoreInternalClientError("CORE_INTERNAL_AUTH_FAILED", "Worker 无法通过 Web 内部服务鉴权。", retryable=False)
        if response.status_code >= 500:
            raise CoreInternalClientError("CORE_INTERNAL_UNAVAILABLE", "Web 内部服务暂时不可用。", retryable=True)
        if not 200 <= response.status_code < 300:
            raise CoreInternalClientError("CARD_CONTENT_PERSISTENCE_REJECTED", "Web 拒绝了节点内容持久化请求。", retryable=False)
        try:
            return PersistedCardContentEnvelope.model_validate(response.json())
        except (ValidationError, ValueError) as error:
            raise CoreInternalClientError("CORE_INTERNAL_RESPONSE_INVALID", "Web 内部服务返回了不符合契约的数据。", retryable=False) from error
    async def get_default_model_connection(
        self,
        agent_run_id: UUID,
    ) -> DefaultModelConnectionEnvelope:
        """获取任务所有者的 active 默认连接，响应中只包含 API Key 密文。"""
        if self._internal_service_secret is None:
            raise CoreInternalClientError(
                "INTERNAL_SERVICE_SECRET_MISSING",
                "Worker 与 Web 的内部服务密钥尚未配置。",
                retryable=False,
            )

        url = f"{self._base_url}/agent-runs/{agent_run_id}/default-model-connection"
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                response = await client.get(
                    url,
                    headers={
                        "Accept": "application/json",
                        "X-LearnCraft-Internal-Secret": self._internal_service_secret.get_secret_value(),
                        "User-Agent": "LearnCraft-Agent/0.1",
                    },
                )
        except httpx.HTTPError as error:
            raise CoreInternalClientError(
                "CORE_INTERNAL_UNAVAILABLE",
                "Web 内部服务暂时不可用。",
                retryable=True,
            ) from error

        if response.status_code == 404:
            raise CoreInternalClientError(
                "DEFAULT_MODEL_CONNECTION_NOT_FOUND",
                "当前账户没有可用的默认模型连接。",
                retryable=False,
            )
        if response.status_code in {401, 403}:
            raise CoreInternalClientError(
                "CORE_INTERNAL_AUTH_FAILED",
                "Worker 无法通过 Web 内部服务鉴权。",
                retryable=False,
            )
        if response.status_code >= 500:
            raise CoreInternalClientError(
                "CORE_INTERNAL_UNAVAILABLE",
                "Web 内部服务暂时不可用。",
                retryable=True,
            )
        if not 200 <= response.status_code < 300:
            raise CoreInternalClientError(
                "CORE_INTERNAL_RESPONSE_INVALID",
                "Web 内部服务返回了不受支持的响应。",
                retryable=False,
            )

        try:
            return DefaultModelConnectionEnvelope.model_validate(response.json())
        except (ValidationError, ValueError) as error:
            raise CoreInternalClientError(
                "CORE_INTERNAL_RESPONSE_INVALID",
                "Web 内部服务返回了不符合契约的数据。",
                retryable=False,
            ) from error
