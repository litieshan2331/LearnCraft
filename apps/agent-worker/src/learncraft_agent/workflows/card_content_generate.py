"""节点知识内容生成工作流。

主要类型：
- CardContentGenerationInput：节点内容生成输入快照。
- CardContentDocument：节点内容持久化合同。
- CardContentWorkflow：调用模型并将已校验内容交给 Web Core。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal
from uuid import uuid4

import orjson
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from learncraft_agent.acl.web_core_internal_client import WebCoreInternalClient
from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelGatewayError,
    ModelMessage,
    ModelProviderConnection,
    ModelToolCall,
)
from learncraft_agent.application.services.tool_aware_generator import ToolAwareGenerator
from learncraft_agent.core.config import get_settings
from learncraft_agent.infrastructure.llm.credential_decryptor import ModelCredentialDecryptor
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import OpenAiCompatibleModelGateway
from learncraft_agent.infrastructure.llm.safe_egress_client import get_safe_model_egress_client
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import TAVILY_SEARCH_TOOL, TavilyRemoteMcpToolGateway
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState


class CardContentGenerationInput(BaseModel):
    """表示 Web 冻结的节点内容生成输入。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_role: Literal["node_tutor"]
    logical_session_key: str = Field(min_length=1, max_length=200)
    goal: dict[str, Any]
    learner_profile: dict[str, Any]
    learning_plan: dict[str, Any]
    plan_node: dict[str, Any]


class CardContentDocument(BaseModel):
    """表示供用户阅读、后测和引用追踪使用的节点内容合同。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["card_content.v1"] = "card_content.v1"
    foundation: str = Field(min_length=1, max_length=12_000)
    worked_example: dict[str, Any]
    pitfalls_debug: str = Field(min_length=1, max_length=12_000)
    source_refs: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    teaching_memory: dict[str, Any]

    @classmethod
    def from_json(cls, content: str) -> "CardContentDocument":
        """从模型文本中提取 JSON 并执行统一合同校验。"""
        try:
            raw = orjson.loads(content)
        except orjson.JSONDecodeError as error:
            raise ValueError("模型内容不是合法 JSON。") from error
        return cls.model_validate(_normalize_card_content(raw))


class CardContentWorkflow:
    """执行节点知识内容生成并通过内部接口持久化。"""

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        """读取节点快照、调用模型、校验内容并回写 Web。"""
        settings = get_settings()
        try:
            value = CardContentGenerationInput.model_validate(state.input_summary_json)
        except ValidationError as error:
            raise ModelGatewayError("CARD_CONTENT_INPUT_INVALID", "节点内容生成输入不符合契约。", retryable=False) from error

        internal = WebCoreInternalClient(
            base_url=settings.core_internal_base_url,
            internal_service_secret=settings.internal_service_secret,
        )
        envelope = await internal.get_default_model_connection(state.run_id)
        api_key = ModelCredentialDecryptor(
            encryption_key=settings.credential_encryption_key,
            key_version=settings.credential_encryption_key_version,
        ).decrypt(owner_id=envelope.owner_id, credential=envelope.credential)
        connection = ModelProviderConnection(
            owner_id=envelope.owner_id,
            connection_id=envelope.connection_id,
            base_url=envelope.base_url,
            model_id=envelope.model_id,
            api_key=api_key,
        )
        gateway = OpenAiCompatibleModelGateway(
            egress_client=get_safe_model_egress_client(),
            request_max_retries=settings.model_gateway_request_max_retries,
        )
        request = self._build_request(state, value, connection)
        tool_gateway = TavilyRemoteMcpToolGateway(settings=settings, owner_id=state.owner_id)
        generation = await ToolAwareGenerator(
            model_gateway=gateway,
            tool_gateway=tool_gateway,
            max_tool_calls=settings.agent_tool_max_calls,
        ).generate(request)
        try:
            document = await self._parse_or_repair(
                gateway=gateway,
                request=request,
                content=generation.content,
            )
        except ModelGatewayError:
            document = await self._rebuild_with_tavily(
                gateway=gateway,
                tool_gateway=tool_gateway,
                state=state,
                value=value,
                connection=connection,
            )

        persisted = await internal.persist_card_content(
            agent_run_id=state.run_id,
            payload={
                **document.model_dump(mode="json"),
                "plan_node_id": value.plan_node["id"],
                "generation_metadata": {
                    "model_id": connection.model_id,
                    "tool_call_count": generation.tool_call_count,
                    "logical_session_key": value.logical_session_key,
                },
            },
        )
        return {
            "card_content_id": str(persisted.card_content_id),
            "plan_node_id": str(value.plan_node["id"]),
            "tool_call_count": generation.tool_call_count,
            "model_id": connection.model_id,
        }

    @staticmethod
    async def _complete_document(
        gateway: OpenAiCompatibleModelGateway,
        request: ModelCompletionRequest,
    ) -> CardContentDocument:
        """调用一次无工具模型请求并使用兼容规范化解析内容合同。"""
        response = await gateway.complete(request)
        if response.message.tool_calls or response.message.content is None:
            raise ModelGatewayError(
                "CARD_CONTENT_OUTPUT_INVALID",
                "模型没有返回可校验的节点内容。",
                retryable=False,
            )
        return CardContentDocument.from_json(
            gateway._extract_json_text(response.message.content),
        )
    @staticmethod
    async def _parse_or_repair(
        *,
        gateway: OpenAiCompatibleModelGateway,
        request: ModelCompletionRequest,
        content: str,
    ) -> CardContentDocument:
        """先校验首轮结果，失败时执行一次无工具结构化修复。"""
        try:
            return CardContentDocument.from_json(gateway._extract_json_text(content))
        except (ValidationError, ValueError):
            repair_request = request.model_copy(
                update={
                    "messages": request.messages + (
                        ModelMessage(role="assistant", content=content),
                        ModelMessage(
                            role="system",
                            content="上一轮节点内容不符合 card_content.v1。请只返回严格合法 JSON，补齐 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory，不要输出额外文字。",
                        ),
                    ),
                    "tools": (),
                    "tool_choice": "none",
                },
            )
            try:
                return await CardContentWorkflow._complete_document(gateway, repair_request)
            except ModelGatewayError as repair_error:
                raise ModelGatewayError(
                    "CARD_CONTENT_OUTPUT_INVALID",
                    "节点知识内容经过修复后仍不符合内容合同。",
                    retryable=False,
                ) from repair_error

    async def _rebuild_without_sources(
        self,
        *,
        gateway: OpenAiCompatibleModelGateway,
        state: AgentRunExecutionState,
        value: CardContentGenerationInput,
        connection: ModelProviderConnection,
        tavily_error: str,
    ) -> CardContentDocument:
        """Tavily 不可用时使用模型稳定知识恢复，保持同一内容合同。"""
        fallback_request = self._build_request(state, value, connection).model_copy(
            update={
                "messages": (
                    ModelMessage(
                        role="system",
                        content="联网资料不可用，请仅使用你已有的稳定知识生成节点内容。只输出严格 JSON，必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory；worked_example 必须有 explanation、code、call_sequence、expected_output；source_refs 可以为空；不要输出额外文字。",
                    ),
                    ModelMessage(
                        role="user",
                        content=f"节点：{value.plan_node.get('title', '')}\n联网工具错误类别：{tavily_error}",
                    ),
                ),
                "tools": (),
                "tool_choice": "none",
            },
        )
        try:
            return await self._complete_document(gateway, fallback_request)
        except ModelGatewayError as error:
            raise ModelGatewayError(
                "CARD_CONTENT_MODEL_RECOVERY_INVALID",
                f"无资料模型恢复结果仍不符合节点内容合同（联网错误类别：{tavily_error}）。",
                retryable=False,
            ) from error
    async def _rebuild_with_tavily(
        self,
        *,
        gateway: OpenAiCompatibleModelGateway,
        tool_gateway: TavilyRemoteMcpToolGateway,
        state: AgentRunExecutionState,
        value: CardContentGenerationInput,
        connection: ModelProviderConnection,
    ) -> CardContentDocument:
        """最终校验失败时强制 Tavily 搜索，并要求模型基于资料重建内容。"""
        query = (
            f"{value.goal.get('topic', '')} {value.plan_node.get('title', '')} 官方文档 教程"
        )[:500]
        tool_result = await tool_gateway.execute(
            ModelToolCall(
                id=f"forced_tavily_{uuid4().hex}",
                name=TAVILY_SEARCH_TOOL.name,
                arguments_json=orjson.dumps({"query": query}).decode(),
            ),
        )
        if not tool_result.ok:
            return await self._rebuild_without_sources(
                gateway=gateway,
                state=state,
                value=value,
                connection=connection,
                tavily_error=tool_result.code,
            )
        source_context = orjson.dumps(tool_result.data).decode()
        fallback_request = self._build_request(state, value, connection).model_copy(
            update={
                "messages": (
                    ModelMessage(
                        role="system",
                        content="你正在执行节点知识内容的最终联网兜底。请只输出严格 JSON，必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory；worked_example 必须有 explanation、code、call_sequence、expected_output；只能基于下方 Tavily 资料，不要输出额外文字。",
                    ),
                    ModelMessage(
                        role="user",
                        content=f"节点：{value.plan_node.get('title', '')}\nTavily 资料摘要：{source_context}",
                    ),
                ),
                "tools": (),
                "tool_choice": "none",
            },
        )
        try:
            return await self._complete_document(gateway, fallback_request)
        except ModelGatewayError as error:
            raise ModelGatewayError(
                "CARD_CONTENT_TAVILY_RECOVERY_INVALID",
                "Tavily 兜底生成的节点内容仍不符合内容合同。",
                retryable=False,
            ) from error
    @staticmethod
    def _build_request(
        state: AgentRunExecutionState,
        value: CardContentGenerationInput,
        connection: ModelProviderConnection,
    ) -> ModelCompletionRequest:
        """构造节点教学提示词，允许模型自主选择 Tavily。"""
        node = value.plan_node
        system = (
            "你是 LearnCraft 的 Node Tutor。请生成可阅读的节点知识文档，最终只输出严格 JSON。"
            "所有面向学习者的文字使用简体中文，技术名词和代码可保留英文。"
            "内容必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory。"
            "worked_example 必须包含 explanation、code、call_sequence、expected_output；不包含本地运行命令、依赖安装、stdout 或伪造执行结果。"
            "teaching_memory 必须包含 key_concepts、common_mistakes、assessment_targets。"
            "稳定知识可直接生成；涉及近期 API、版本或不确定事实时可自主调用 tavily_search。"
        )
        user = "\n".join(
            (
                f"学习主题：{value.goal.get('topic', '')}",
                f"学习目标：{value.goal.get('desired_outcome', '')}",
                f"学习者水平：{value.learner_profile.get('current_level', '')}",
                f"章节标题：{node.get('title', '')}",
                f"章节摘要：{node.get('node_brief', '')}",
                f"章节目标：{node.get('learning_objective', '')}",
                f"完成标准：{orjson.dumps(node.get('completion_criteria', [])).decode()}",
            ),
        )
        return ModelCompletionRequest(
            agent_run_id=state.run_id,
            connection=connection,
            messages=(
                ModelMessage(role="system", content=system),
                ModelMessage(role="user", content=user),
            ),
            tools=(TAVILY_SEARCH_TOOL,),
            tool_choice="auto",
            response_format="json_object",
        )
def _normalize_card_content(raw: object) -> dict[str, Any]:
    """将模型常见的宽松字段收敛为 card_content.v1 的稳定形状。"""
    if not isinstance(raw, Mapping):
        raise ValueError("模型内容必须是 JSON 对象。")

    worked_raw = raw.get("worked_example") or raw.get("example") or raw.get("workedExample")
    if isinstance(worked_raw, Mapping):
        worked_example = {
            "explanation": _content_text(
                worked_raw.get("explanation") or worked_raw.get("description"),
                "本示例演示本章节核心概念的基本用法。",
                4_000,
            ),
            "code": _content_text(
                worked_raw.get("code") or worked_raw.get("snippet"),
                "# 请根据本章节目标补充示例代码",
                12_000,
            ),
            "call_sequence": _content_text_list(
                worked_raw.get("call_sequence") or worked_raw.get("steps"),
                ["准备输入", "执行核心步骤", "核对结果"],
                50,
            ),
            "expected_output": _content_text(
                worked_raw.get("expected_output") or worked_raw.get("output"),
                "示例应输出符合章节目标的结果。",
                4_000,
            ),
        }
    else:
        worked_example = {
            "explanation": _content_text(
                worked_raw,
                "本示例演示本章节核心概念的基本用法。",
                4_000,
            ),
            "code": "# 请根据本章节目标补充示例代码",
            "call_sequence": ["准备输入", "执行核心步骤", "核对结果"],
            "expected_output": "示例应输出符合章节目标的结果。",
        }

    memory_raw = raw.get("teaching_memory") or raw.get("teachingMemory")
    memory = memory_raw if isinstance(memory_raw, Mapping) else {}
    return {
        "schema_version": "card_content.v1",
        "foundation": _content_text(
            raw.get("foundation") or raw.get("content") or raw.get("summary"),
            "本章节围绕节点目标建立必要概念，并说明它们之间的关系。",
            12_000,
        ),
        "worked_example": worked_example,
        "pitfalls_debug": _content_text(
            raw.get("pitfalls_debug") or raw.get("pitfalls") or raw.get("common_mistakes"),
            "注意区分输入类型、边界条件和执行顺序；遇到结果异常时逐步检查这些前置条件。",
            12_000,
        ),
        "source_refs": _content_mapping_list(raw.get("source_refs") or raw.get("references")),
        "teaching_memory": {
            "key_concepts": _content_text_list(
                memory.get("key_concepts") or memory.get("concepts"),
                ["本章节核心概念"],
                30,
            ),
            "common_mistakes": _content_text_list(
                memory.get("common_mistakes") or memory.get("mistakes"),
                ["忽略边界条件或概念之间的区别"],
                30,
            ),
            "assessment_targets": _content_text_list(
                memory.get("assessment_targets") or memory.get("targets"),
                ["能够解释并应用本章节核心概念"],
                30,
            ),
        },
    }


def _content_text(value: object, default: str, maximum: int) -> str:
    """提取内容字段并限制长度，缺失时返回安全默认文案。"""
    if isinstance(value, str) and value.strip():
        return value.strip()[:maximum]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)[:maximum]
    return default


def _content_text_list(value: object, default: list[str], maximum: int) -> list[str]:
    """将字符串或列表收敛为有界字符串数组。"""
    if isinstance(value, str) and value.strip():
        return [value.strip()[:500]]
    if isinstance(value, list):
        values = [
            item.strip()[:500]
            for item in value
            if isinstance(item, str) and item.strip()
        ]
        if values:
            return values[:maximum]
    return default


def _content_mapping_list(value: object) -> list[dict[str, Any]]:
    """只保留来源引用中的对象，避免把任意模型值写入引用数组。"""
    if not isinstance(value, list):
        return []
    return [
        dict(item)
        for item in value
        if isinstance(item, Mapping)
    ][:20]