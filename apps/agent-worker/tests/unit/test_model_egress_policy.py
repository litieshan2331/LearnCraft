"""模型 Provider 受控出网策略测试。

类：
- FakeDnsResolver：为策略测试提供确定性的 DNS 解析结果。
函数：
- 各测试函数：验证 HTTPS、域名、DNS 公网地址与固定 IP 请求路径约束。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from uuid import uuid4

import httpx
import pytest

from learncraft_agent.application.ports.model_egress_audit import ModelEgressAuditEntry
from learncraft_agent.infrastructure.llm.egress_policy import (
    ModelEgressPolicy,
    ModelEgressPolicyError,
    ResolvedModelEndpoint,
)
from learncraft_agent.infrastructure.llm.safe_egress_client import (
    ModelEgressOptions,
    SafeModelEgressClient,
)


class FakeDnsResolver:
    """返回测试预设结果的 DNS 解析器。"""

    def __init__(self, addresses: Sequence[str]) -> None:
        self.addresses = addresses
        self.calls: list[str] = []

    async def resolve(self, hostname: str) -> Sequence[str]:
        """记录被解析的主机名并返回预设地址。"""
        self.calls.append(hostname)
        return self.addresses


class FakeAuditWriter:
    """收集审计事件而不访问数据库的端口实现。"""

    def __init__(self) -> None:
        self.entries: list[ModelEgressAuditEntry] = []

    async def record(self, entry: ModelEgressAuditEntry) -> None:
        """保存测试中传入的最小审计事件。"""
        self.entries.append(entry)


class FakePolicy:
    """返回固定端点的策略替身，用于验证客户端不会把域名交给连接层。"""

    async def resolve_endpoint(self, base_url: str) -> ResolvedModelEndpoint:
        """忽略输入并返回已校验的公开 IP 端点。"""
        return ResolvedModelEndpoint(
            base_url="https://api.example.com/v1",
            hostname="api.example.com",
            port=443,
            pinned_ip="8.8.8.8",
        )


class FakeAsyncClient:
    """捕获 HTTP 请求且返回固定 JSON 响应的 httpx 客户端替身。"""

    last_request: httpx.Request | None = None

    def __init__(self, **_: object) -> None:
        pass

    async def __aenter__(self) -> "FakeAsyncClient":
        """进入异步上下文。"""
        return self

    async def __aexit__(self, *args: object) -> None:
        """退出异步上下文。"""

    def build_request(
        self,
        method: str,
        url: httpx.URL,
        *,
        content: bytes,
        headers: Mapping[str, str],
    ) -> httpx.Request:
        """构造供被测客户端补充 TLS SNI 的标准 httpx 请求。"""
        return httpx.Request(method, url, content=content, headers=headers)

    async def send(self, request: httpx.Request, *, stream: bool) -> httpx.Response:
        """记录请求并返回小型成功 JSON 响应。"""
        assert stream is True
        type(self).last_request = request
        return httpx.Response(200, json={"id": "chatcmpl-test"}, request=request)


@pytest.mark.asyncio
async def test_policy_requires_public_https_domain_and_pins_first_public_ip() -> None:
    """公网 HTTPS 域名应在本次调用中保留其受检验的第一个 IP。"""
    resolver = FakeDnsResolver(("8.8.8.8", "1.1.1.1"))
    endpoint = await ModelEgressPolicy(resolver).resolve_endpoint(
        "https://API.Example.com:443/v1/",
    )

    assert resolver.calls == ["api.example.com"]
    assert endpoint.base_url == "https://api.example.com/v1"
    assert endpoint.hostname == "api.example.com"
    assert endpoint.port == 443
    assert endpoint.pinned_ip == "8.8.8.8"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("base_url", "code"),
    [
        ("http://api.example.com", "MODEL_EGRESS_INVALID_URL"),
        ("https://api.example.com:8443", "MODEL_EGRESS_INVALID_URL"),
        ("https://8.8.8.8", "MODEL_EGRESS_LITERAL_IP_FORBIDDEN"),
        ("https://[2606:4700:4700::1111]", "MODEL_EGRESS_LITERAL_IP_FORBIDDEN"),
        ("https://localhost/v1", "MODEL_EGRESS_LOCAL_HOST_FORBIDDEN"),
        ("https://api.example.com/v1/../admin", "MODEL_EGRESS_INVALID_URL_PATH"),
    ],
)
async def test_policy_rejects_unsafe_or_nonstandard_base_urls(
    base_url: str,
    code: str,
) -> None:
    """协议、端口、IP 字面量、本地名称和相对路径都不能成为 Provider 地址。"""
    with pytest.raises(ModelEgressPolicyError) as error:
        await ModelEgressPolicy(FakeDnsResolver(("8.8.8.8",))).resolve_endpoint(
            base_url,
        )

    assert error.value.code == code


@pytest.mark.asyncio
@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.0.1", "::1"])
async def test_policy_rejects_when_any_dns_answer_is_not_public(address: str) -> None:
    """域名只要有任意一个解析结果落入内网或保留网段，就必须整体拒绝。"""
    with pytest.raises(ModelEgressPolicyError) as error:
        await ModelEgressPolicy(FakeDnsResolver(("8.8.8.8", address))).resolve_endpoint(
            "https://api.example.com",
        )

    assert error.value.code == "MODEL_EGRESS_PRIVATE_IP_FORBIDDEN"


def test_pinned_request_url_never_contains_the_provider_domain() -> None:
    """实际请求 URL 必须是已校验 IP，原域名仅供 Host 与 TLS SNI 使用。"""
    request_url = SafeModelEgressClient._build_pinned_request_url(
        ResolvedModelEndpoint(
            base_url="https://api.example.com/v1",
            hostname="api.example.com",
            port=443,
            pinned_ip="8.8.8.8",
        ),
        ("chat", "completions"),
    )

    assert str(request_url) == "https://8.8.8.8/v1/chat/completions"


@pytest.mark.asyncio
async def test_safe_client_uses_pinned_ip_with_original_host_and_tls_sni(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """真实调用入口应只连接 IP，同时以域名执行 Provider 路由和证书校验。"""
    from learncraft_agent.infrastructure.llm import safe_egress_client

    monkeypatch.setattr(safe_egress_client.httpx, "AsyncClient", FakeAsyncClient)
    audit_writer = FakeAuditWriter()
    client = SafeModelEgressClient(
        options=ModelEgressOptions(
            enabled=True,
            proxy_url=None,
            connect_timeout_seconds=10,
            read_timeout_seconds=120,
            max_response_bytes=1024,
        ),
        audit_writer=audit_writer,
        policy=FakePolicy(),  # type: ignore[arg-type]
    )

    response = await client.post_openai_compatible_json(
        owner_id=uuid4(),
        model_connection_id=uuid4(),
        agent_run_id=None,
        base_url="https://api.example.com/v1",
        api_key="test-api-key",
        endpoint_segments=("chat", "completions"),
        payload={"model": "test-model", "messages": []},
    )

    assert response.payload == {"id": "chatcmpl-test"}
    assert FakeAsyncClient.last_request is not None
    assert str(FakeAsyncClient.last_request.url) == "https://8.8.8.8/v1/chat/completions"
    assert FakeAsyncClient.last_request.headers["host"] == "api.example.com"
    assert FakeAsyncClient.last_request.extensions["sni_hostname"] == "api.example.com"
    assert [(entry.decision, entry.reason_code) for entry in audit_writer.entries] == [
        ("allowed", "MODEL_EGRESS_POLICY_ALLOWED"),
    ]
