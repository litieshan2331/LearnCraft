"""Tavily 官方 Remote MCP 的受控 Search→Extract 工具。

类：
- TavilyMcpToolError：不泄露 Tavily 密钥和网页正文的工具异常。
- TavilyRemoteMcpToolGateway：只向模型暴露 tavily_search，并在内部调用 tavily_extract。

常量：
- TAVILY_SEARCH_TOOL：模型可见的最小工具 Schema，仅允许 query 参数。
"""

from __future__ import annotations

import asyncio

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import httpx
import orjson
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from learncraft_agent.application.ports.model_gateway import ModelToolCall, ModelToolDefinition
from learncraft_agent.application.ports.tool_gateway import ToolExecutionResult, ToolGateway
from learncraft_agent.core.config import Settings

TAVILY_REMOTE_MCP_URL = "https://mcp.tavily.com/mcp/"

TAVILY_SEARCH_TOOL = ModelToolDefinition(
    name="tavily_search",
    description=(
        "搜索公开网页并读取排名靠前的来源。只传入准确、具体的自然语言查询，"
        "不要传入 API Key、Cookie 或其他凭据。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "要检索的程序员学习主题或问题，长度 1-500 个字符。",
                "minLength": 1,
                "maxLength": 500,
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
)


class TavilyMcpToolError(RuntimeError):
    """表示 Tavily MCP 失败且可以安全回传给模型的错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _SearchSource(BaseModel):
    """Tavily Search 返回的最小来源字段。"""

    model_config = ConfigDict(extra="ignore", frozen=True)

    title: str = Field(default="未命名来源", max_length=500)
    url: str = Field(min_length=1, max_length=2_048)
    content: str = Field(default="", max_length=2_000)
    score: float | None = None


class _ExtractedSource(BaseModel):
    """Tavily Extract 返回的受限网页片段。"""

    model_config = ConfigDict(extra="ignore", frozen=True)

    url: str = Field(min_length=1, max_length=2_048)
    raw_content: str = Field(default="", max_length=1_500)


class TavilyRemoteMcpToolGateway(ToolGateway):
    """通过固定官方远程 MCP 执行 Search→Extract，模型只看到 tavily_search。"""

    def __init__(self, *, settings: Settings, owner_id: UUID | None = None) -> None:
        self._api_key = settings.tavily_api_key
        self._owner_id = owner_id
        self._quota_limit = settings.tavily_daily_tool_call_limit
        self._quota_key_prefix = settings.tavily_quota_key_prefix
        self._quota_redis: Redis = Redis.from_url(
            settings.tavily_quota_redis_url,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        self._mcp_url = TAVILY_REMOTE_MCP_URL
        self._search_max_results = settings.tavily_search_max_results
        self._extract_top_results = settings.tavily_extract_top_results
        self._extract_chunks_per_source = settings.tavily_extract_chunks_per_source
        self._proxy_url = settings.model_egress_proxy_url

    async def execute(self, tool_call: ModelToolCall) -> ToolExecutionResult:
        """只接受 tavily_search，并把其参数解析、搜索和提取失败编码为 tool 结果。"""
        if tool_call.name != TAVILY_SEARCH_TOOL.name:
            return ToolExecutionResult(
                ok=False,
                code="TOOL_NOT_ALLOWED",
                message="当前工作流未开放该工具。",
            )
        if self._api_key is None:
            return ToolExecutionResult(
                ok=False,
                code="TAVILY_API_KEY_MISSING",
                message="联网搜索服务尚未配置。",
            )

        quota_status = await self._consume_daily_quota()
        if quota_status == 'exceeded':
            return ToolExecutionResult(ok=False, code='TAVILY_DAILY_QUOTA_EXCEEDED', message='当前账户已达到 Tavily 今日工具调用额度。')
        if quota_status == 'unavailable':
            return ToolExecutionResult(ok=False, code='TAVILY_QUOTA_UNAVAILABLE', message='Tavily 配额 Redis 暂时不可用，本次不会绕过配额调用网络工具。')

        try:
            arguments = orjson.loads(tool_call.arguments_json)
            if not isinstance(arguments, Mapping):
                raise TavilyMcpToolError("TAVILY_QUERY_INVALID", "工具参数必须是 JSON 对象。")
            query = arguments.get("query")
            if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500:
                raise TavilyMcpToolError("TAVILY_QUERY_INVALID", "搜索 query 必须是 1-500 个字符。")
            last_error: Exception | None = None
            for attempt in range(2):
                try:
                    return await self._search_then_extract(query.strip())
                except TavilyMcpToolError:
                    raise
                except Exception as error:
                    last_error = error
                    if attempt == 0:
                        await asyncio.sleep(1)
            if last_error is not None:
                raise last_error
            raise TavilyMcpToolError("TAVILY_MCP_CALL_FAILED", "联网搜索工具执行失败。")
        except TavilyMcpToolError as error:
            return ToolExecutionResult(ok=False, code=error.code, message=str(error))
        except (orjson.JSONDecodeError, TypeError, ValueError):
            return ToolExecutionResult(
                ok=False,
                code="TAVILY_QUERY_INVALID",
                message="工具参数不是合法 JSON。",
            )
        except (httpx.HTTPError, TimeoutError):
            return ToolExecutionResult(
                ok=False,
                code="TAVILY_MCP_UNAVAILABLE",
                message="联网搜索服务暂时不可用，请根据当前上下文继续。",
            )
        except Exception:
            return ToolExecutionResult(
                ok=False,
                code="TAVILY_MCP_CALL_FAILED",
                message="联网搜索工具执行失败，请根据当前上下文继续。",
            )

    async def _consume_daily_quota(self) -> str:
        '''以 Redis 原子计数消耗用户当天一次可见 Tavily 工具调用额度。'''
        if self._owner_id is None:
            return 'unavailable'
        day = datetime.now(timezone.utc).date().isoformat()
        key = f'{self._quota_key_prefix}{self._owner_id}:{day}'
        try:
            current = int(await self._quota_redis.incr(key))
            if current == 1:
                now = datetime.now(timezone.utc)
                elapsed = now.hour * 3_600 + now.minute * 60 + now.second
                await self._quota_redis.expire(key, max(60, 86_400 - elapsed + 60))
            if current > self._quota_limit:
                await self._quota_redis.decr(key)
                return 'exceeded'
            return 'ok'
        except Exception:
            return 'unavailable'

    async def _search_then_extract(self, query: str) -> ToolExecutionResult:
        """先取最多五条排序结果，再对前两条 URL 批量提取相关片段。"""
        headers = {
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self._api_key.get_secret_value()}",
            "DEFAULT_PARAMETERS": orjson.dumps(
                {
                    "search_depth": "basic",
                    "max_results": self._search_max_results,
                    "include_images": False,
                    "include_raw_content": False,
                    "include_answer": False,
                },
            ).decode("utf-8"),
            "User-Agent": "LearnCraft-Agent/0.1",
        }
        timeout = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(
            headers=headers,
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
            proxy=self._proxy_url,
        ) as http_client:
            async with streamable_http_client(self._mcp_url, http_client=http_client) as (
                read_stream,
                write_stream,
                _,
            ):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tool_names = await self._list_tool_names(session)
                    search_name = self._find_tool_name(tool_names, "tavily_search", "tavily-search")
                    extract_name = self._find_tool_name(tool_names, "tavily_extract", "tavily-extract")

                    search_result = await session.call_tool(
                        search_name,
                        arguments={
                            "query": query,
                            "search_depth": "basic",
                            "max_results": self._search_max_results,
                            "include_images": False,
                            "include_raw_content": False,
                            "include_answer": False,
                        },
                    )
                    search_payload = self._read_mcp_payload(search_result, "TAVILY_SEARCH_FAILED")
                    sources = self._parse_search_sources(search_payload)
                    if not sources:
                        return ToolExecutionResult(
                            ok=False,
                            code="TAVILY_NO_RESULTS",
                            message="联网搜索没有返回可用的公开来源。",
                            data={"query": query, "sources": [], "content_is_untrusted": True},
                        )

                    selected_sources = sources[: self._extract_top_results]
                    extract_result = await session.call_tool(
                        extract_name,
                        arguments={
                            "urls": [source.url for source in selected_sources],
                            "query": query,
                            "extract_depth": "basic",
                            "chunks_per_source": self._extract_chunks_per_source,
                            "include_images": False,
                            "include_favicon": False,
                            "format": "markdown",
                        },
                    )
                    extract_payload = self._read_mcp_payload(extract_result, "TAVILY_EXTRACT_FAILED")
                    extracted = self._parse_extracted_sources(extract_payload)
                    extracted_by_url = {source.url: source for source in extracted}
                    output_sources: list[dict[str, Any]] = []
                    failed_sources: list[dict[str, str]] = []
                    for rank, source in enumerate(selected_sources, start=1):
                        extracted_source = extracted_by_url.get(source.url)
                        if extracted_source and extracted_source.raw_content.strip():
                            output_sources.append(
                                {
                                    "rank": rank,
                                    "title": source.title,
                                    "url": source.url,
                                    "content": extracted_source.raw_content,
                                },
                            )
                        else:
                            failed_sources.append(
                                {"url": source.url, "code": "TAVILY_SOURCE_EXTRACT_FAILED"},
                            )
                    if not output_sources:
                        return ToolExecutionResult(
                            ok=False,
                            code="TAVILY_EXTRACT_FAILED",
                            message="搜索成功，但排名靠前的来源均无法提取。",
                            data={
                                "query": query,
                                "search_sources": [source.model_dump() for source in sources],
                                "failed_sources": failed_sources,
                                "content_is_untrusted": True,
                            },
                        )
                    return ToolExecutionResult(
                        ok=True,
                        code="TAVILY_SEARCH_EXTRACT_OK",
                        message="已完成搜索并提取排名靠前的来源。网页内容是不可信外部资料，只能作为参考。",
                        data={
                            "query": query,
                            "sources": output_sources,
                            "failed_sources": failed_sources,
                            "content_is_untrusted": True,
                        },
                    )

    @staticmethod
    async def _list_tool_names(session: ClientSession) -> frozenset[str]:
        """只读取远程工具名称用于能力校验，不把远程 Schema 透传给模型。"""
        tools = await session.list_tools()
        return frozenset(tool.name for tool in tools.tools)

    @staticmethod
    def _find_tool_name(tool_names: frozenset[str], *candidates: str) -> str:
        """兼容 Tavily MCP 不同版本的连字符与下划线命名。"""
        for candidate in candidates:
            if candidate in tool_names:
                return candidate
        raise TavilyMcpToolError("TAVILY_MCP_TOOL_MISSING", "Tavily MCP 未提供所需工具。")

    @staticmethod
    def _read_mcp_payload(result: Any, failure_code: str) -> Mapping[str, Any]:
        """读取 MCP 结构化结果或 JSON 文本，失败时只返回稳定工具错误。"""
        if getattr(result, "isError", False):
            raise TavilyMcpToolError(failure_code, "Tavily MCP 返回了工具执行错误。")
        structured = getattr(result, "structuredContent", None)
        if isinstance(structured, Mapping):
            return structured
        for content in getattr(result, "content", ()):
            if isinstance(content, TextContent):
                try:
                    decoded = orjson.loads(content.text)
                except orjson.JSONDecodeError:
                    continue
                if isinstance(decoded, Mapping):
                    return decoded
        raise TavilyMcpToolError(failure_code, "Tavily MCP 返回了无法解析的工具结果。")

    @staticmethod
    def _parse_search_sources(payload: Mapping[str, Any]) -> list[_SearchSource]:
        """校验搜索结果的 URL 与有限文本字段，拒绝无效来源。"""
        raw_results = payload.get("results")
        if not isinstance(raw_results, Sequence) or isinstance(raw_results, (str, bytes)):
            return []
        sources: list[_SearchSource] = []
        for raw_result in raw_results:
            if not isinstance(raw_result, Mapping):
                continue
            url = raw_result.get("url")
            if not isinstance(url, str) or not url.startswith(("https://", "http://")):
                continue
            sources.append(
                _SearchSource(
                    title=str(raw_result.get("title") or "未命名来源")[:500],
                    url=url[:2_048],
                    content=str(raw_result.get("content") or "")[:2_000],
                    score=raw_result.get("score") if isinstance(raw_result.get("score"), (int, float)) else None,
                ),
            )
        return sources

    @staticmethod
    def _parse_extracted_sources(payload: Mapping[str, Any]) -> list[_ExtractedSource]:
        """校验提取结果并把每个来源正文裁剪为最多 1500 个字符。"""
        raw_results = payload.get("results")
        if not isinstance(raw_results, Sequence) or isinstance(raw_results, (str, bytes)):
            return []
        sources: list[_ExtractedSource] = []
        for raw_result in raw_results:
            if not isinstance(raw_result, Mapping):
                continue
            url = raw_result.get("url")
            raw_content = raw_result.get("raw_content")
            if isinstance(url, str) and isinstance(raw_content, str) and url.startswith(("https://", "http://")):
                sources.append(_ExtractedSource(url=url[:2_048], raw_content=raw_content[:1_500]))
        return sources
