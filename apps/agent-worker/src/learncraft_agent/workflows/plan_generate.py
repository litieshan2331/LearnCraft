"""学习路线生成工作流。

主要类型：
- PlanGenerationInput：目标、画像和已评分前测的结构化输入。
- LearningPlanDocument：供 Web Core 持久化的章节式学习路线合同。
- PlanGenerationWorkflow：生成、校验、修复并持久化学习路线。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal
from uuid import uuid4

import orjson
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

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
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import (
    OpenAiCompatibleModelGateway,
)
from learncraft_agent.infrastructure.llm.safe_egress_client import get_safe_model_egress_client
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import (
    TAVILY_SEARCH_TOOL,
    TavilyRemoteMcpToolGateway,
)
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)


class PlanGoalInput(BaseModel):
    """表示路线生成所需的学习目标快照。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=64)
    topic: str = Field(min_length=1, max_length=300)
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(min_length=1, max_length=2_000)
    desired_outcome: str = Field(min_length=1, max_length=2_000)


class PlanLearnerProfileInput(BaseModel):
    """表示路线生成时冻结的学习者画像快照。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    profile_version: int = Field(ge=1)
    current_level: Literal["beginner", "intermediate", "advanced"]
    weekly_minutes: int = Field(ge=30, le=10_080)
    background_summary: str | None = Field(default=None, max_length=4_000)


class PlanAssessmentInput(BaseModel):
    """表示已确定性评分的前测摘要。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    assessment_id: str = Field(min_length=1, max_length=64)
    score_percent: float = Field(ge=0, le=100)
    mastery_summary: dict[str, Any] = Field(default_factory=dict)


class PlanGenerationInput(BaseModel):
    """定义路线生成的目标、画像与前测交接快照。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    goal: PlanGoalInput
    learner_profile: PlanLearnerProfileInput
    diagnostic_assessment: PlanAssessmentInput


class LearningPlanNode(BaseModel):
    """表示书籍章节式路线中的一个可独立学习主题。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    node_key: str = Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_]*$")
    ordinal: int = Field(ge=1, le=12)
    title: str = Field(min_length=1, max_length=255)
    node_brief: str = Field(min_length=1, max_length=2_000)
    learning_objective: str = Field(min_length=1, max_length=2_000)
    rationale: str = Field(min_length=1, max_length=2_000)
    difficulty: int = Field(ge=1, le=5)
    estimated_minutes: int = Field(ge=5, le=1_440)
    prerequisite_node_keys: list[str] = Field(default_factory=list, max_length=11)
    completion_criteria: list[str] = Field(min_length=1, max_length=10)

    @field_validator("prerequisite_node_keys")
    @classmethod
    def validate_prerequisite_keys(cls, values: list[str]) -> list[str]:
        """确保节点依赖键格式稳定且没有重复。"""
        if len(set(values)) != len(values):
            raise ValueError("prerequisite_node_keys 不能包含重复项")
        for value in values:
            if not value or len(value) > 100 or not value.replace("_", "").isalnum() or not value[0].islower():
                raise ValueError("prerequisite_node_keys 必须是小写稳定 node_key")
        return values


class LearningPlanDocument(BaseModel):
    """表示可持久化的完整学习路线输出合同。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["learning_plan.v1"] = "learning_plan.v1"
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(min_length=1, max_length=2_000)
    nodes: list[LearningPlanNode] = Field(min_length=6, max_length=12)

    @model_validator(mode="after")
    def validate_route_structure(self) -> "LearningPlanDocument":
        """校验章节顺序、依赖引用和无环 DAG。"""
        keys = [node.node_key for node in self.nodes]
        if len(set(keys)) != len(keys):
            raise ValueError("node_key 必须唯一")

        ordinals = [node.ordinal for node in self.nodes]
        if sorted(ordinals) != list(range(1, len(self.nodes) + 1)):
            raise ValueError("ordinal 必须从 1 开始连续编号")

        key_set = set(keys)
        prerequisites = {
            node.node_key: node.prerequisite_node_keys
            for node in self.nodes
        }
        for node in self.nodes:
            for prerequisite_key in node.prerequisite_node_keys:
                if prerequisite_key not in key_set:
                    raise ValueError("前置节点必须存在于当前路线")
                if prerequisite_key == node.node_key:
                    raise ValueError("节点不能依赖自身")

        if _has_cycle(prerequisites):
            raise ValueError("路线前置依赖必须无环")
        return self


class PlanGenerationWorkflow:
    """执行 plan_generate：模型可自主调用 Tavily，最终校验失败后强制 Tavily 重建。"""

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        """生成、校验并通过 Core API 持久化章节式学习路线。"""
        settings = get_settings()
        try:
            value = PlanGenerationInput.model_validate(state.input_summary_json)
        except ValidationError as error:
            raise ModelGatewayError(
                "PLAN_INPUT_INVALID",
                "学习路线生成输入不符合契约。",
                retryable=False,
            ) from error

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
        tool_gateway = TavilyRemoteMcpToolGateway(
            settings=settings,
            owner_id=state.owner_id,
        )
        generation = await ToolAwareGenerator(
            model_gateway=gateway,
            tool_gateway=tool_gateway,
            max_tool_calls=settings.agent_tool_max_calls,
        ).generate(request)

        plan, repair_attempts = await self._parse_or_repair(
            gateway=gateway,
            request=request,
            content=generation.content,
        )
        generation_path = "model_with_tavily" if generation.tool_call_count else "model_knowledge"
        fallback_used = False

        if plan is None:
            fallback_used = True
            generation_path = "tavily_recovery"
            plan = await self._rebuild_with_tavily(
                gateway=gateway,
                tool_gateway=tool_gateway,
                state=state,
                value=value,
                connection=connection,
            )

        persisted = await internal.persist_learning_plan(
            agent_run_id=state.run_id,
            payload={
                **plan.model_dump(mode="json"),
                "generation_metadata": {
                    "model_id": connection.model_id,
                    "tool_call_count": generation.tool_call_count,
                    "repair_attempts": repair_attempts,
                    "generation_path": generation_path,
                    "fallback_used": fallback_used,
                },
            },
        )
        return {
            "learning_plan_id": str(persisted.learning_plan_id),
            "node_count": persisted.node_count,
            "tool_call_count": generation.tool_call_count,
            "repair_attempts": repair_attempts,
            "generation_path": generation_path,
            "model_id": connection.model_id,
        }

    @staticmethod
    def _build_request(
        state: AgentRunExecutionState,
        value: PlanGenerationInput,
        connection: ModelProviderConnection,
    ) -> ModelCompletionRequest:
        """构造允许模型自主联网的章节式学习路线生成请求。"""
        system = (
            "你是 LearnCraft 的学习路线规划师。你只生成学习路线，不生成知识正文或题目。"
            "最终必须只输出一个严格 JSON 对象，不能输出 Markdown 或额外解释。"
            "路线必须像一本技术书的章节目录：6 到 12 个可独立学习的主题章节，不能使用泛化的“了解概念、练习、复盘”阶段模板。"
            "所有面向学习者的文字使用简体中文；技术专有名词、代码和标识符可保留英文。"
            "当主题涉及近期版本、快速变化 API、兼容性或你对事实没有足够把握时，可以使用 tavily_search。"
            "对于稳定且有把握的知识可直接生成；不要为调用工具而调用工具。"
            "JSON 顶层只能包含 schema_version、title、summary、nodes。"
            "每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria。"
            "node_key 使用小写英文和下划线，ordinal 必须从 1 连续编号。"
            "依赖只能指向当前 nodes 中已存在的 node_key，依赖图必须无环。"
        )
        user = "\n".join((
            f"学习主题：{value.goal.topic}",
            f"目标标题：{value.goal.title}",
            f"目标描述：{value.goal.description}",
            f"期望结果：{value.goal.desired_outcome}",
            f"学习者水平：{value.learner_profile.current_level}",
            f"每周可用分钟：{value.learner_profile.weekly_minutes}",
            f"学习背景：{value.learner_profile.background_summary or ''}",
            f"前测得分：{value.diagnostic_assessment.score_percent}",
            f"前测薄弱点摘要：{orjson.dumps(value.diagnostic_assessment.mastery_summary).decode('utf-8')}",
            "请生成一条 6-12 章的书籍章节式学习路线。",
        ))
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

    @staticmethod
    async def _parse_or_repair(
        *,
        gateway: OpenAiCompatibleModelGateway,
        request: ModelCompletionRequest,
        content: str,
    ) -> tuple[LearningPlanDocument | None, int]:
        """执行两次无工具修复；仍无法校验时交由强制 Tavily 兜底。"""
        candidate = content
        for attempt in range(3):
            try:
                return (
                    LearningPlanDocument.model_validate_json(
                        gateway._extract_json_text(candidate),
                    ),
                    attempt,
                )
            except (ValidationError, ValueError):
                if attempt == 2:
                    return None, attempt
                repair_request = request.model_copy(
                    update={
                        "messages": request.messages + (
                            ModelMessage(role="assistant", content=candidate),
                            ModelMessage(
                                role="system",
                                content=(
                                    "上一轮路线不符合输出 Schema 或章节依赖规则。"
                                    "请只输出修复后的严格合法 JSON；不得输出额外文字，也不得调用工具。"
                                ),
                            ),
                        ),
                        "tools": (),
                        "tool_choice": "none",
                    },
                )
                response = await gateway.complete(repair_request)
                if response.message.tool_calls or response.message.content is None:
                    return None, attempt + 1
                candidate = response.message.content
        raise AssertionError("路线修复循环不应在没有返回时结束")

    @staticmethod
    async def _parse_recovery_response(
        *,
        gateway: OpenAiCompatibleModelGateway,
        request: ModelCompletionRequest,
        response_content: str | None,
        has_tool_calls: bool,
        error_code: str,
        failure_message: str,
    ) -> LearningPlanDocument:
        """解析最终恢复结果，失败时执行一次结构化修复并返回安全字段路径。"""
        if has_tool_calls or response_content is None:
            raise ModelGatewayError(
                error_code,
                f"{failure_message} 校验路径: response.content_missing",
                retryable=False,
            )

        candidate = response_content
        validation_paths: list[str] = []
        for attempt in range(2):
            try:
                return LearningPlanDocument.model_validate(
                    _normalize_recovery_document(
                        gateway._extract_json_text(candidate),
                    ),
                )
            except (ValidationError, ValueError) as error:
                validation_paths = _validation_paths(error)
                if attempt == 1:
                    break
                repair_request = request.model_copy(
                    update={
                        "messages": request.messages + (
                            ModelMessage(role="assistant", content=candidate),
                            ModelMessage(
                                role="system",
                                content=(
                                    f'上一轮路线恢复结果未通过校验，字段路径为：{", ".join(validation_paths[:8])}。请只返回严格 JSON，'
                                    "顶层只能有 schema_version、title、summary、nodes；每个 node 只能有 node_key、ordinal、title、node_brief、learning_objective、"
                                    "rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；禁止 description、topics、goal、dependencies 等旧字段；nodes 必须为 6-12 个章节、ordinal 连续、依赖存在且无环；不要输出解释文字。"
                                ),
                            ),
                        ),
                        "tools": (),
                        "tool_choice": "none",
                    },
                )
                repaired = await gateway.complete(repair_request)
                if repaired.message.tool_calls or repaired.message.content is None:
                    validation_paths = ["response.repair_content_missing"]
                    break
                candidate = repaired.message.content

        path_summary = ", ".join(validation_paths[:8]) or "response.json"
        raise ModelGatewayError(
            error_code,
            f"{failure_message} 校验路径: {path_summary}",
            retryable=False,
        )

    async def _rebuild_without_sources(
        self,
        *,
        gateway: OpenAiCompatibleModelGateway,
        state: AgentRunExecutionState,
        value: PlanGenerationInput,
        connection: ModelProviderConnection,
        tavily_error_code: str,
    ) -> LearningPlanDocument:
        """Tavily 不可用时的最后安全恢复，仍必须通过同一份路线合同。"""
        request = self._build_request(state, value, connection).model_copy(
            update={
                "messages": (
                    ModelMessage(
                        role="system",
                        content=
                            "Tavily 联网兜底暂时不可用。请仅使用你已有的稳定知识，严格按 schema_version、title、summary、nodes 输出；"
                            "每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；禁止 description、topics、goal、dependencies 等旧字段；路线必须有 6-12 个章节、ordinal 连续、依赖存在且无环。"
                            "不要调用工具，不要输出额外文字。",
                    ),
                    ModelMessage(
                        role="user",
                        content=f"学习主题：{value.goal.topic}\\n目标：{value.goal.desired_outcome}\\nTavily 错误类别：{tavily_error_code}",
                    ),
                ),
                "tools": (),
                "tool_choice": "none",
            },
        )
        response = await gateway.complete(request)
        return await self._parse_recovery_response(
            gateway=gateway,
            request=request,
            response_content=response.message.content,
            has_tool_calls=bool(response.message.tool_calls),
            error_code="PLAN_MODEL_RECOVERY_INVALID",
            failure_message="无资料模型恢复结果仍不符合路线合同。",
        )

    async def _rebuild_with_tavily(
        self,
        *,
        gateway: OpenAiCompatibleModelGateway,
        tool_gateway: TavilyRemoteMcpToolGateway,
        state: AgentRunExecutionState,
        value: PlanGenerationInput,
        connection: ModelProviderConnection,
    ) -> LearningPlanDocument:
        """在最终校验失败后强制 Tavily 搜索、阅读并重建路线。"""
        query = (
            f"{value.goal.topic} 官方文档 教程 目录 "
            f"{value.goal.desired_outcome}"
        )[:500]
        tool_result = await tool_gateway.execute(
            ModelToolCall(
                id=f"forced_tavily_{uuid4().hex}",
                name=TAVILY_SEARCH_TOOL.name,
                arguments_json=orjson.dumps({"query": query}).decode("utf-8"),
            ),
        )
        if not tool_result.ok:
            return await self._rebuild_without_sources(
                gateway=gateway,
                state=state,
                value=value,
                connection=connection,
                tavily_error_code=tool_result.code,
            )

        source_context = orjson.dumps(
            tool_result.data,
            option=orjson.OPT_SORT_KEYS,
        ).decode("utf-8")
        request = self._build_request(state, value, connection).model_copy(
            update={
                "messages": (
                    ModelMessage(
                        role="system",
                        content=(
                            "你正在执行强制联网兜底。请仅基于以下 Tavily 搜索和资源阅读摘要，严格按 schema_version、title、summary、nodes 输出；"
                            "每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；禁止 description、topics、goal、dependencies 等旧字段；路线必须有 6-12 个章节、ordinal 连续、依赖存在且无环。"
                        ),
                    ),
                    ModelMessage(
                        role="user",
                        content=(
                            f"学习主题：{value.goal.topic}\n"
                            f"目标：{value.goal.desired_outcome}\n"
                            f"参考资料摘要：{source_context}"
                        ),
                    ),
                ),
                "tools": (),
                "tool_choice": "none",
            },
        )
        response = await gateway.complete(request)
        return await self._parse_recovery_response(
            gateway=gateway,
            request=request,
            response_content=response.message.content,
            has_tool_calls=bool(response.message.tool_calls),
            error_code="PLAN_TAVILY_SOURCE_RECOVERY_INVALID",
            failure_message="基于 Tavily 资料的路线恢复结果仍不符合路线合同。",
        )

def _normalize_recovery_document(content: str) -> dict[str, Any]:
    """将恢复输出的旧字段和松散值收敛为当前路线合同。"""
    try:
        raw_document = orjson.loads(content)
    except orjson.JSONDecodeError as error:
        raise ValueError("response.json") from error
    if not isinstance(raw_document, Mapping):
        raise ValueError("response.object")

    raw_nodes = raw_document.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("nodes")

    drafts: list[dict[str, Any]] = []
    used_keys: set[str] = set()
    title_to_key: dict[str, str] = {}

    for index, raw_node in enumerate(raw_nodes, start=1):
        node = raw_node if isinstance(raw_node, Mapping) else {}
        title = _recovery_text(node.get("title") or node.get("name"), f"第 {index} 章", 255)
        node_key = _recovery_node_key(node.get("node_key"), index, used_keys)
        used_keys.add(node_key)
        title_to_key[title] = node_key
        drafts.append({
            "node_key": node_key,
            "ordinal": index,
            "title": title,
            "node_brief": _recovery_text(
                node.get("node_brief") or node.get("description") or node.get("summary"),
                f"学习{title}的关键概念和适用边界。",
                2_000,
            ),
            "learning_objective": _recovery_text(
                node.get("learning_objective") or node.get("goal") or node.get("objective"),
                f"能够完成{title}的核心学习目标。",
                2_000,
            ),
            "rationale": _recovery_text(
                node.get("rationale") or node.get("reason"),
                f"{title}承接前置知识并支撑后续章节。",
                2_000,
            ),
            "difficulty": _recovery_difficulty(node.get("difficulty"), index),
            "estimated_minutes": _recovery_minutes(
                node.get("estimated_minutes") or node.get("duration_minutes"),
            ),
            "completion_criteria": _recovery_criteria(
                node.get("completion_criteria") or node.get("completion_criterion"),
                title,
            ),
            "_raw_prerequisites": (
                node.get("prerequisite_node_keys")
                or node.get("dependencies")
                or node.get("prerequisites")
                or []
            ),
        })

    all_keys = {draft["node_key"] for draft in drafts}
    for index, draft in enumerate(drafts):
        prerequisite_keys = _recovery_prerequisites(
            raw_values=draft.pop("_raw_prerequisites"),
            current_key=draft["node_key"],
            all_keys=all_keys,
            title_to_key=title_to_key,
        )
        if not prerequisite_keys and index > 0:
            prerequisite_keys = [drafts[index - 1]["node_key"]]
        draft["prerequisite_node_keys"] = prerequisite_keys

    return {
        "schema_version": "learning_plan.v1",
        "title": _recovery_text(
            raw_document.get("title") or raw_document.get("plan_title"),
            "学习路线",
            255,
        ),
        "summary": _recovery_text(
            raw_document.get("summary") or raw_document.get("description"),
            "按章节组织的学习路线。",
            2_000,
        ),
        "nodes": drafts,
    }


def _recovery_text(value: object, default: str, maximum: int) -> str:
    """提取长度受限的非空文本，并在缺失时提供可读默认值。"""
    if isinstance(value, str) and value.strip():
        return value.strip()[:maximum]
    return default


def _recovery_node_key(value: object, index: int, used_keys: set[str]) -> str:
    """将非法或重复 node_key 降级为稳定 chapter 序号键。"""
    candidate = value.strip().lower() if isinstance(value, str) else ""
    candidate = "".join(
        character if character.isascii() and (character.islower() or character.isdigit() or character == "_")
        else "_"
        for character in candidate
    ).strip("_")
    if not candidate or not candidate[0].islower() or candidate in used_keys:
        candidate = f"chapter_{index}"
    while candidate in used_keys:
        candidate = f"{candidate}_{index}"
    return candidate[:100]


def _recovery_difficulty(value: object, index: int) -> int:
    """将常见字符串或数值难度收敛到 1-5。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return min(5, max(1, round(value)))
    if isinstance(value, str):
        normalized = value.strip().lower()
        mapping = {
            "beginner": 1, "basic": 1, "初级": 1, "easy": 2,
            "intermediate": 3, "medium": 3, "中级": 3,
            "advanced": 4, "hard": 4, "高级": 4, "expert": 5,
        }
        if normalized in mapping:
            return mapping[normalized]
        if normalized.isdigit():
            return min(5, max(1, int(normalized)))
    return min(5, max(1, (index + 1) // 2))


def _recovery_minutes(value: object) -> int:
    """将时长收敛到路线合同的 5-1440 分钟范围。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return min(1_440, max(5, round(value)))
    if isinstance(value, str) and value.strip().isdigit():
        return min(1_440, max(5, int(value.strip())))
    return 45


def _recovery_criteria(value: object, title: str) -> list[str]:
    """将字符串或字符串列表的完成标准规范为非空列表。"""
    values = _recovery_string_list(value)
    return values[:10] or [f"能够完成{title}的核心示例。"]


def _recovery_prerequisites(
    *,
    raw_values: object,
    current_key: str,
    all_keys: set[str],
    title_to_key: Mapping[str, str],
) -> list[str]:
    """只保留可解析到当前路线节点的前置依赖。"""
    resolved: list[str] = []
    for raw_value in _recovery_string_list(raw_values):
        key = title_to_key.get(raw_value, raw_value)
        if key in all_keys and key != current_key and key not in resolved:
            resolved.append(key)
    return resolved


def _recovery_string_list(value: object) -> list[str]:
    """将单字符串、列表或对象值收敛为非空字符串列表。"""
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    if isinstance(value, Mapping):
        return [
            str(item).strip()
            for item in value.values()
            if isinstance(item, (str, int, float)) and str(item).strip()
        ]
    return []
def _has_cycle(prerequisites_by_key: Mapping[str, list[str]]) -> bool:
    """以深度优先遍历校验路线前置依赖图无环。"""
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_key: str) -> bool:
        if node_key in visiting:
            return True
        if node_key in visited:
            return False

        visiting.add(node_key)
        for prerequisite_key in prerequisites_by_key.get(node_key, []):
            if visit(prerequisite_key):
                return True
        visiting.remove(node_key)
        visited.add(node_key)
        return False

    return any(visit(node_key) for node_key in prerequisites_by_key)

def _validation_paths(error: ValidationError | ValueError) -> list[str]:
    """只提取校验字段路径，不记录模型原文或敏感值。"""
    if isinstance(error, ValidationError):
        paths: list[str] = []
        for item in error.errors():
            location = item.get("loc", ())
            path = ".".join(str(part) for part in location)
            if path and path not in paths:
                paths.append(path)
        return paths
    return ["response.json"]
