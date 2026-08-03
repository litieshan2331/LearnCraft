"""模型 Provider 的 URL、DNS 与 IP 受控出网策略。

类：
- ModelEgressPolicyError：携带稳定错误码的安全策略拒绝异常。
- SystemDnsResolver：每次请求重新解析域名的系统 DNS 解析器。
- ModelEgressPolicy：校验 Base URL，并仅返回已确认的公网 IP 连接目标。
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Protocol, Sequence
from urllib.parse import unquote, urlsplit, urlunsplit


class ModelEgressPolicyError(ValueError):
    """表示模型 Provider 地址不满足受控出网安全策略。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AsyncDnsResolver(Protocol):
    """解析域名到全部候选地址的最小异步接口。"""

    async def resolve(self, hostname: str) -> Sequence[str]:
        """返回当前 DNS 响应中的全部去重 IP 地址。"""


class SystemDnsResolver:
    """基于运行环境 DNS 的解析器；刻意不跨请求缓存结果。"""

    async def resolve(self, hostname: str) -> Sequence[str]:
        """获取 A/AAAA 结果，并把 DNS 失败转换为稳定错误码。"""
        try:
            addresses = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: socket.getaddrinfo(
                    hostname,
                    443,
                    type=socket.SOCK_STREAM,
                ),
            )
        except socket.gaierror as error:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_DNS_RESOLUTION_FAILED",
                "模型服务域名无法解析。",
            ) from error

        resolved = tuple(dict.fromkeys(result[4][0] for result in addresses))
        if not resolved:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_DNS_RESOLUTION_EMPTY",
                "模型服务域名没有可用的 DNS 解析结果。",
            )
        return resolved


@dataclass(frozen=True, slots=True)
class ResolvedModelEndpoint:
    """已通过策略校验、且本次连接必须固定使用的模型服务端点。"""

    base_url: str
    hostname: str
    port: int
    pinned_ip: str


class ModelEgressPolicy:
    """只允许公网 HTTPS 域名，并在每次调用中重新解析及校验全部 IP。"""

    def __init__(self, resolver: AsyncDnsResolver | None = None) -> None:
        self._resolver = resolver or SystemDnsResolver()

    async def resolve_endpoint(self, base_url: str) -> ResolvedModelEndpoint:
        """校验 Provider Base URL，返回可用于固定连接的解析结果。"""
        parsed = self._parse_public_https_url(base_url)
        hostname = self._canonicalize_hostname(parsed.hostname)
        self._ensure_hostname_is_not_literal_or_local(hostname)

        resolved_ips = await self._resolver.resolve(hostname)
        validated_ips = tuple(
            self._ensure_public_resolved_ip(address)
            for address in resolved_ips
        )
        if not validated_ips:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_DNS_RESOLUTION_EMPTY",
                "模型服务域名没有可用的 DNS 解析结果。",
            )

        path = parsed.path.rstrip("/")
        normalized_url = urlunsplit(("https", hostname, path, "", ""))
        return ResolvedModelEndpoint(
            base_url=normalized_url,
            hostname=hostname,
            port=443,
            pinned_ip=validated_ips[0],
        )

    @staticmethod
    def _parse_public_https_url(base_url: str):
        """验证 URL 结构，只保留 HTTPS、443 与不含鉴权信息的路径前缀。"""
        try:
            parsed = urlsplit(base_url.strip())
            port = parsed.port
        except ValueError as error:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_INVALID_URL",
                "模型服务地址格式不正确。",
            ) from error

        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or port not in {None, 443}
        ):
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_INVALID_URL",
                "模型服务地址必须是无认证信息、无查询参数的公网 HTTPS 域名，且仅允许 443 端口。",
            )

        decoded_segments = (segment for segment in unquote(parsed.path).split("/") if segment)
        if any(segment in {".", ".."} for segment in decoded_segments):
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_INVALID_URL_PATH",
                "模型服务地址不能包含相对路径片段。",
            )
        return parsed

    @staticmethod
    def _canonicalize_hostname(hostname: str | None) -> str:
        """将 Unicode 域名转换为安全比较所需的标准 ASCII 形式。"""
        if hostname is None:
            raise ModelEgressPolicyError("MODEL_EGRESS_INVALID_URL", "模型服务地址缺少域名。")
        try:
            canonical = hostname.encode("idna").decode("ascii").lower().rstrip(".")
        except UnicodeError as error:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_INVALID_HOST",
                "模型服务域名格式不正确。",
            ) from error
        if not canonical:
            raise ModelEgressPolicyError("MODEL_EGRESS_INVALID_HOST", "模型服务域名不能为空。")
        return canonical

    @staticmethod
    def _ensure_hostname_is_not_literal_or_local(hostname: str) -> None:
        """拒绝所有 IP 字面量和本地解析域名，避免用户指向内网或本机。"""
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_LITERAL_IP_FORBIDDEN",
                "模型服务地址不能使用 IP 字面量。",
            )

        if hostname.replace(".", "").isdigit() or hostname in {"localhost", "local"} or hostname.endswith((".localhost", ".local")):
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_LOCAL_HOST_FORBIDDEN",
                "模型服务地址不能指向本机或局域网域名。",
            )

    @staticmethod
    def _ensure_public_resolved_ip(address: str) -> str:
        """确认 DNS 的每一个 A/AAAA 结果均为可公开路由地址。"""
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError as error:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_DNS_INVALID_RESULT",
                "模型服务域名返回了不合法的 DNS 结果。",
            ) from error

        if not parsed.is_global:
            raise ModelEgressPolicyError(
                "MODEL_EGRESS_PRIVATE_IP_FORBIDDEN",
                "模型服务域名不能解析到私有、保留或本地网络地址。",
            )
        return str(parsed)
