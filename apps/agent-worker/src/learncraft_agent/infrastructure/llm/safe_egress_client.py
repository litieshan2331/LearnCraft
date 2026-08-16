"""模型 Provider 的固定 IP 受控 HTTP 客户端。

类：
- ModelEgressOptions：模型出网的超时、响应大小和代理配置。
- ModelEgressRequestError：不泄露密钥或响应正文的模型调用异常。
- ModelProviderJsonResponse：成功 Provider 调用的最小 JSON 响应。
- SafeModelEgressClient：先审计、再以已校验 IP 连接 Provider 的唯一 HTTP 入口。
函数：
- get_safe_model_egress_client：组装供 ModelGateway 注入的进程内共享安全客户端。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Awaitable, Callable, Mapping, Sequence, TypeVar
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import orjson

from learncraft_agent.application.ports.model_egress_audit import (
    ModelEgressAuditEntry,
    ModelEgressAuditWriter,
)
from learncraft_agent.core.config import Settings
from learncraft_agent.infrastructure.llm.egress_policy import (
    ModelEgressPolicy,
    ModelEgressPolicyError,
    ResolvedModelEndpoint,
)
from learncraft_agent.infrastructure.persistence.database import create_session_factory
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_model_egress_audit_repository import (
    SqlAlchemyModelEgressAuditRepository,
)

logger = logging.getLogger(__name__)
ProviderResponse = TypeVar('ProviderResponse')


class ModelEgressRequestError(RuntimeError):
    """表示已通过策略但无法安全完成模型请求的错误。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        provider_error_code: str | None = None,
        provider_error_message: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.provider_error_code = provider_error_code
        self.provider_error_message = provider_error_message


@dataclass(frozen=True, slots=True)
class ModelEgressOptions:
    """模型受控出网的运行时上限；代理存在时仍使用固定 IP 作为 CONNECT 目标。"""

    enabled: bool
    proxy_url: str | None
    connect_timeout_seconds: float
    read_timeout_seconds: float
    max_response_bytes: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ModelEgressOptions":
        """将 Worker 配置转换为不含敏感信息的受控出网选项。"""
        return cls(
            enabled=settings.model_egress_enabled,
            proxy_url=settings.model_egress_proxy_url,
            connect_timeout_seconds=settings.model_egress_connect_timeout_seconds,
            read_timeout_seconds=settings.model_egress_read_timeout_seconds,
            max_response_bytes=settings.model_egress_max_response_bytes,
        )


@dataclass(frozen=True, slots=True)
class ModelProviderJsonResponse:
    """供后续 OpenAI-compatible ModelGateway 读取的安全 JSON 响应。"""

    status_code: int
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class ModelProviderSseResponse:
    '''表示已在受控出网层完成边界校验的 OpenAI SSE 事件序列。'''

    status_code: int
    events: tuple[Mapping[str, Any], ...]


class SafeModelEgressClient:
    """模型调用唯一出网入口：不跟随重定向，且绝不把域名交给连接层再次解析。"""

    def __init__(
        self,
        *,
        options: ModelEgressOptions,
        audit_writer: ModelEgressAuditWriter,
        policy: ModelEgressPolicy | None = None,
    ) -> None:
        self._options = options
        self._audit_writer = audit_writer
        self._policy = policy or ModelEgressPolicy()

    @classmethod
    def from_settings(
        cls,
        *,
        settings: Settings,
        audit_writer: ModelEgressAuditWriter,
        policy: ModelEgressPolicy | None = None,
    ) -> "SafeModelEgressClient":
        """使用 Worker Settings 创建后续 ModelGateway 应注入的客户端。"""
        return cls(
            options=ModelEgressOptions.from_settings(settings),
            audit_writer=audit_writer,
            policy=policy,
        )

    async def post_openai_compatible_json(
        self,
        *,
        owner_id: UUID,
        model_connection_id: UUID,
        agent_run_id: UUID | None,
        base_url: str,
        api_key: str,
        endpoint_segments: Sequence[str],
        payload: Mapping[str, Any],
    ) -> ModelProviderJsonResponse:
        '''向 OpenAI-compatible Provider 发起非流式 JSON 请求。'''
        return await self._post_openai_compatible(
            owner_id=owner_id,
            model_connection_id=model_connection_id,
            agent_run_id=agent_run_id,
            base_url=base_url,
            api_key=api_key,
            endpoint_segments=endpoint_segments,
            payload=payload,
            accept='application/json',
            response_reader=self._read_json_response,
        )

    async def post_openai_compatible_sse(
        self,
        *,
        owner_id: UUID,
        model_connection_id: UUID,
        agent_run_id: UUID | None,
        base_url: str,
        api_key: str,
        endpoint_segments: Sequence[str],
        payload: Mapping[str, Any],
    ) -> ModelProviderSseResponse:
        '''向 OpenAI-compatible Provider 发起 SSE 请求并在内存中安全聚合事件。'''
        return await self._post_openai_compatible(
            owner_id=owner_id,
            model_connection_id=model_connection_id,
            agent_run_id=agent_run_id,
            base_url=base_url,
            api_key=api_key,
            endpoint_segments=endpoint_segments,
            payload=payload,
            accept='text/event-stream',
            response_reader=self._read_sse_response,
        )

    async def _post_openai_compatible(
        self,
        *,
        owner_id: UUID,
        model_connection_id: UUID,
        agent_run_id: UUID | None,
        base_url: str,
        api_key: str,
        endpoint_segments: Sequence[str],
        payload: Mapping[str, Any],
        accept: str,
        response_reader: Callable[[httpx.Response], Awaitable[ProviderResponse]],
    ) -> ProviderResponse:
        """以固定 IP、原始域名 SNI 和受限路径向 OpenAI-compatible Provider 发起 POST。"""
        if not self._options.enabled:
            raise ModelEgressRequestError(
                "MODEL_EGRESS_DISABLED",
                "模型受控出网尚未启用。",
                retryable=False,
            )
        if not api_key.strip():
            raise ModelEgressRequestError(
                "MODEL_PROVIDER_API_KEY_MISSING",
                "模型连接缺少可用的 API Key。",
                retryable=False,
            )

        try:
            endpoint = await self._policy.resolve_endpoint(base_url)
        except ModelEgressPolicyError as error:
            await self._record_blocked_best_effort(
                owner_id=owner_id,
                model_connection_id=model_connection_id,
                agent_run_id=agent_run_id,
                base_url=base_url,
                reason_code=error.code,
            )
            raise

        await self._record_or_block(
            ModelEgressAuditEntry(
                owner_id=owner_id,
                model_connection_id=model_connection_id,
                agent_run_id=agent_run_id,
                host=endpoint.hostname,
                port=endpoint.port,
                decision="allowed",
                reason_code="MODEL_EGRESS_POLICY_ALLOWED",
            ),
        )

        request_url = self._build_pinned_request_url(endpoint, endpoint_segments)
        timeout = httpx.Timeout(
            connect=self._options.connect_timeout_seconds,
            read=self._options.read_timeout_seconds,
            write=self._options.connect_timeout_seconds,
            pool=self._options.connect_timeout_seconds,
        )
        transport = httpx.AsyncHTTPTransport(
            verify=True,
            trust_env=False,
            http1=True,
            http2=False,
            proxy=self._options.proxy_url,
            retries=0,
        )

        try:
            async with httpx.AsyncClient(
                transport=transport,
                timeout=timeout,
                follow_redirects=False,
            ) as client:
                request = client.build_request(
                    "POST",
                    request_url,
                    content=orjson.dumps(payload),
                    headers={
                        "Accept": accept,
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Host": endpoint.hostname,
                        "User-Agent": "LearnCraft-Agent/0.1",
                    },
                )
                # httpcore 以该扩展设置 TLS SNI/证书校验名称；TCP/CONNECT 目标仍是 pinned_ip。
                request.extensions["sni_hostname"] = endpoint.hostname
                response = await client.send(request, stream=True)
                try:
                    return await response_reader(response)
                finally:
                    await response.aclose()
        except ModelEgressRequestError:
            raise
        except httpx.HTTPError as error:
            await self._record_request_failed_best_effort(
                owner_id=owner_id,
                model_connection_id=model_connection_id,
                agent_run_id=agent_run_id,
                endpoint=endpoint,
                reason_code="MODEL_EGRESS_HTTP_ERROR",
            )
            raise ModelEgressRequestError(
                "MODEL_EGRESS_HTTP_ERROR",
                "模型服务请求失败。",
                retryable=True,
            ) from error

    async def _read_json_response(self, response: httpx.Response) -> ModelProviderJsonResponse:
        """拒绝重定向和过大响应，并将成功响应限制为 JSON 对象。"""
        if 300 <= response.status_code < 400:
            raise ModelEgressRequestError(
                "MODEL_EGRESS_REDIRECT_FORBIDDEN",
                "模型服务响应了不允许跟随的重定向。",
                retryable=False,
            )

        content_length = response.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > self._options.max_response_bytes:
            raise ModelEgressRequestError(
                "MODEL_EGRESS_RESPONSE_TOO_LARGE",
                "模型服务响应超过允许大小。",
                retryable=False,
            )

        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > self._options.max_response_bytes:
                raise ModelEgressRequestError(
                    "MODEL_EGRESS_RESPONSE_TOO_LARGE",
                    "模型服务响应超过允许大小。",
                    retryable=False,
                )

        if not 200 <= response.status_code < 300:
            provider_error_code, provider_error_message = self._extract_provider_error_context(
                bytes(body),
            )
            logger.warning(
                'model_provider_non_success status=%s provider_error_code=%s provider_error_message=%s',
                response.status_code,
                provider_error_code,
                provider_error_message,
            )
            raise ModelEgressRequestError(
                f"MODEL_PROVIDER_HTTP_{response.status_code}",
                "模型服务返回了非成功状态。",
                retryable=response.status_code == 429 or response.status_code >= 500,
                provider_error_code=provider_error_code,
                provider_error_message=provider_error_message,
            )

        try:
            decoded = orjson.loads(body)
        except orjson.JSONDecodeError as error:
            raise ModelEgressRequestError(
                "MODEL_PROVIDER_INVALID_JSON",
                "模型服务返回了无法解析的响应。",
                retryable=False,
            ) from error
        if not isinstance(decoded, dict):
            raise ModelEgressRequestError(
                "MODEL_PROVIDER_INVALID_JSON",
                "模型服务返回了非对象 JSON 响应。",
                retryable=False,
            )
        return ModelProviderJsonResponse(status_code=response.status_code, payload=decoded)

    async def _read_sse_response(self, response: httpx.Response) -> ModelProviderSseResponse:
        '''流式读取 data-only SSE，校验完成标记和总响应大小，但不持久化模型正文。'''
        if 300 <= response.status_code < 400:
            raise ModelEgressRequestError(
                'MODEL_EGRESS_REDIRECT_FORBIDDEN',
                '模型服务响应了不允许跟随的重定向。',
                retryable=False,
            )

        content_length = response.headers.get('content-length')
        if content_length and content_length.isdigit() and int(content_length) > self._options.max_response_bytes:
            raise ModelEgressRequestError(
                'MODEL_EGRESS_RESPONSE_TOO_LARGE',
                '模型服务响应超过允许大小。',
                retryable=False,
            )

        if not 200 <= response.status_code < 300:
            body = await self._read_bounded_response_body(response)
            provider_error_code, provider_error_message = self._extract_provider_error_context(body)
            logger.warning(
                'model_provider_non_success status=%s provider_error_code=%s provider_error_message=%s',
                response.status_code,
                provider_error_code,
                provider_error_message,
            )
            raise ModelEgressRequestError(
                f'MODEL_PROVIDER_HTTP_{response.status_code}',
                '模型服务返回了非成功状态。',
                retryable=response.status_code == 429 or response.status_code >= 500,
                provider_error_code=provider_error_code,
                provider_error_message=provider_error_message,
            )

        content_type = response.headers.get('content-type', '').lower()
        if not content_type.startswith('text/event-stream'):
            raise ModelEgressRequestError(
                'MODEL_PROVIDER_INVALID_SSE',
                '模型服务没有返回 SSE 流。',
                retryable=False,
            )

        events: list[Mapping[str, Any]] = []
        buffer = bytearray()
        received_bytes = 0
        saw_done = False
        async for chunk in response.aiter_bytes():
            received_bytes += len(chunk)
            if received_bytes > self._options.max_response_bytes:
                raise ModelEgressRequestError(
                    'MODEL_EGRESS_RESPONSE_TOO_LARGE',
                    '模型服务响应超过允许大小。',
                    retryable=False,
                )
            buffer.extend(chunk)
            while True:
                newline_index = buffer.find(b'\n')
                if newline_index < 0:
                    break
                raw_line = bytes(buffer[:newline_index]).rstrip(b'\r')
                del buffer[: newline_index + 1]
                if not raw_line or raw_line.startswith(b':'):
                    continue
                if not raw_line.startswith(b'data:'):
                    continue
                raw_data = raw_line[5:].lstrip()
                if raw_data == b'[DONE]':
                    saw_done = True
                    continue
                try:
                    decoded = orjson.loads(raw_data)
                except orjson.JSONDecodeError as error:
                    raise ModelEgressRequestError(
                        'MODEL_PROVIDER_INVALID_SSE',
                        '模型服务返回了无法解析的 SSE 事件。',
                        retryable=False,
                    ) from error
                if not isinstance(decoded, Mapping):
                    raise ModelEgressRequestError(
                        'MODEL_PROVIDER_INVALID_SSE',
                        '模型服务返回了非对象 SSE 事件。',
                        retryable=False,
                    )
                events.append(decoded)

        if buffer.strip():
            raise ModelEgressRequestError(
                'MODEL_PROVIDER_INVALID_SSE',
                '模型服务返回了不完整的 SSE 事件。',
                retryable=False,
            )
        if not saw_done:
            raise ModelEgressRequestError(
                'MODEL_PROVIDER_INVALID_SSE',
                '模型服务未正常结束 SSE 流。',
                retryable=True,
            )
        if not events:
            raise ModelEgressRequestError(
                'MODEL_PROVIDER_INVALID_SSE',
                '模型服务返回了空 SSE 流。',
                retryable=False,
            )
        return ModelProviderSseResponse(status_code=response.status_code, events=tuple(events))

    async def _read_bounded_response_body(self, response: httpx.Response) -> bytes:
        '''读取错误响应正文并执行统一大小限制，用于脱敏 Provider 诊断。'''
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > self._options.max_response_bytes:
                raise ModelEgressRequestError(
                    'MODEL_EGRESS_RESPONSE_TOO_LARGE',
                    '模型服务响应超过允许大小。',
                    retryable=False,
                )
        return bytes(body)

    @staticmethod
    def _extract_provider_error_context(body: bytes) -> tuple[str | None, str | None]:
        '''提取长度受限且已脱敏的 Provider 错误信息，仅供 Worker 日志诊断。'''
        try:
            decoded = orjson.loads(body)
        except orjson.JSONDecodeError:
            return None, None
        if not isinstance(decoded, Mapping):
            return None, None

        raw_error = decoded.get('error')
        error_context = raw_error if isinstance(raw_error, Mapping) else decoded
        raw_code = error_context.get('code') or error_context.get('type')
        raw_message = error_context.get('message')
        error_code = raw_code[:128] if isinstance(raw_code, str) else None
        if not isinstance(raw_message, str):
            return error_code, None
        normalized_message = ' '.join(raw_message.split())[:240]
        redacted_message = re.sub(
            r'(?i)\b(?:sk|key)-[a-z0-9_-]+\b',
            '[REDACTED]',
            normalized_message,
        )
        return error_code, redacted_message

    async def _record_or_block(self, entry: ModelEgressAuditEntry) -> None:
        """在任何外部请求前持久化允许记录；审计不可用时以失败关闭。"""
        try:
            await self._audit_writer.record(entry)
        except Exception as error:
            raise ModelEgressRequestError(
                "MODEL_EGRESS_AUDIT_UNAVAILABLE",
                "模型出网审计暂不可用，已拒绝本次调用。",
                retryable=True,
            ) from error

    async def _record_blocked_best_effort(
        self,
        *,
        owner_id: UUID,
        model_connection_id: UUID,
        agent_run_id: UUID | None,
        base_url: str,
        reason_code: str,
    ) -> None:
        """记录被策略拒绝的请求；审计故障不会改变拒绝结果。"""
        host: str | None = None
        port: int | None = None
        try:
            parsed = urlsplit(base_url)
            host = parsed.hostname
            port = parsed.port
        except ValueError:
            pass

        try:
            await self._audit_writer.record(
                ModelEgressAuditEntry(
                    owner_id=owner_id,
                    model_connection_id=model_connection_id,
                    agent_run_id=agent_run_id,
                    host=host,
                    port=port,
                    decision="blocked",
                    reason_code=reason_code,
                ),
            )
        except Exception:
            return

    async def _record_request_failed_best_effort(
        self,
        *,
        owner_id: UUID,
        model_connection_id: UUID,
        agent_run_id: UUID | None,
        endpoint: ResolvedModelEndpoint,
        reason_code: str,
    ) -> None:
        """记录已通过策略但因传输错误失败的调用，不保存底层异常详情。"""
        try:
            await self._audit_writer.record(
                ModelEgressAuditEntry(
                    owner_id=owner_id,
                    model_connection_id=model_connection_id,
                    agent_run_id=agent_run_id,
                    host=endpoint.hostname,
                    port=endpoint.port,
                    decision="request_failed",
                    reason_code=reason_code,
                ),
            )
        except Exception:
            return

    @staticmethod
    def _build_pinned_request_url(
        endpoint: ResolvedModelEndpoint,
        endpoint_segments: Sequence[str],
    ) -> httpx.URL:
        """将已验证的 Base URL 路径与固定 API 路由拼接到已解析 IP，而非域名。"""
        if not endpoint_segments or any(
            not segment or "/" in segment or segment in {".", ".."}
            for segment in endpoint_segments
        ):
            raise ModelEgressRequestError(
                "MODEL_EGRESS_INVALID_ENDPOINT",
                "模型调用路径不合法。",
                retryable=False,
            )
        base_path = urlsplit(endpoint.base_url).path.rstrip("/")
        path = f"{base_path}/{'/'.join(endpoint_segments)}"
        return httpx.URL(
            scheme="https",
            host=endpoint.pinned_ip,
            port=endpoint.port,
            path=path,
        )


@lru_cache
def get_safe_model_egress_client() -> SafeModelEgressClient:
    """构造进程内共享的安全出网客户端，供后续 ModelGateway 作为唯一外部 HTTP 入口。"""
    from learncraft_agent.core.config import get_settings

    settings = get_settings()
    return SafeModelEgressClient.from_settings(
        settings=settings,
        audit_writer=SqlAlchemyModelEgressAuditRepository(
            create_session_factory(),
            retention_days=settings.model_egress_audit_retention_days,
        ),
    )
