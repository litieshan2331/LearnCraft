"""节点后测生成工作流。

主要类型：
- PosttestGenerationInput：后测任务输入快照。
- PosttestQuestionSet：后测单选题输出合同。
- PosttestWorkflow：读取固定 CardContent 和 teaching_memory，生成并回写后测。
- _normalize_double_escaped_markdown_newlines：规范化题干和解析中的 Markdown 换行。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from learncraft_agent.acl.web_core_internal_client import WebCoreInternalClient
from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelGatewayError,
    ModelMessage,
    ModelProviderConnection,
)
from learncraft_agent.core.config import get_settings
from learncraft_agent.infrastructure.llm.credential_decryptor import ModelCredentialDecryptor
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import OpenAiCompatibleModelGateway
from learncraft_agent.infrastructure.llm.safe_egress_client import get_safe_model_egress_client
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState


def _normalize_double_escaped_markdown_newlines(value: str) -> str:
    """还原题干或解析中被模型双重转义的 Markdown 换行。"""
    if "\n" in value or r"\n" not in value or "```" not in value:
        return value

    normalized: list[str] = []
    index = 0
    while index < len(value):
        if value.startswith(r"\r\n", index):
            normalized.append("\n")
            index += 4
            continue
        if value.startswith(r"\n", index):
            normalized.append("\n")
            index += 2
            continue
        if value.startswith(r"\\", index):
            normalized.append("\\")
            index += 2
            continue
        normalized.append(value[index])
        index += 1
    return "".join(normalized)

class PosttestGenerationInput(BaseModel):
    """表示 Web 冻结的节点后测请求。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    topic: str = Field(min_length=1, max_length=300)
    question_count: int = Field(ge=5, le=10)
    difficulty: Literal["normal", "hard"] = "normal"
    kind: Literal["post_test"]
    plan_node_id: str = Field(min_length=1, max_length=64)
    source_card_content_id: str = Field(min_length=1, max_length=64)


class PosttestOption(BaseModel):
    """表示后测单选题选项。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str = Field(min_length=1, max_length=1, pattern=r"^[A-F]$")
    text: str = Field(min_length=1, max_length=500)


class PosttestQuestion(BaseModel):
    """表示后测确定性评分题目。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    prompt: str = Field(min_length=1, max_length=2_000)
    options: list[PosttestOption] = Field(min_length=2, max_length=6)
    answer_key: str = Field(pattern=r"^[A-F]$")
    explanation: str = Field(min_length=1, max_length=2_000)
    skill_tags: list[str] = Field(default_factory=list, max_length=10)
    max_score: float = Field(default=1, gt=0, le=100)

    @field_validator("prompt", "explanation")
    @classmethod
    def normalize_markdown_newlines(cls, value: str) -> str:
        """在持久化前规范化 Markdown 双重换行转义。"""
        return _normalize_double_escaped_markdown_newlines(value)

    @model_validator(mode="after")
    def validate_answer_key(self) -> "PosttestQuestion":
        """确保正确选项确实存在。"""
        if self.answer_key not in {option.key for option in self.options}:
            raise ValueError("answer_key 必须引用已有选项")
        return self


class PosttestQuestionSet(BaseModel):
    """表示后测题集输出合同。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["assessment.single_choice.v1"] = "assessment.single_choice.v1"
    questions: list[PosttestQuestion] = Field(min_length=5, max_length=10)


class PosttestWorkflow:
    """读取固定节点内容并生成 posttest_generate 题集。"""

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        """读取固定内容、调用模型、校验并回写后测题集。"""
        settings = get_settings()
        try:
            value = PosttestGenerationInput.model_validate(state.input_summary_json)
        except ValidationError as error:
            raise ModelGatewayError("POSTTEST_INPUT_INVALID", "节点后测输入不符合契约。", retryable=False) from error

        internal = WebCoreInternalClient(
            base_url=settings.core_internal_base_url,
            internal_service_secret=settings.internal_service_secret,
        )
        content = await internal.get_card_content_context(state.run_id)
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
        request = self._build_request(state, value, content.model_dump(mode="json"), connection)
        try:
            question_set = await gateway.complete_structured(
                request,
                PosttestQuestionSet,
                repair_instruction=(
                    "后测输出校验失败。请重新输出严格 JSON，不要 Markdown、解释文字或额外字段。"
                    "顶层只能是 schema_version 和 questions，schema_version 必须精确为 assessment.single_choice.v1。"
                    "questions 必须包含恰好请求数量的题目。每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。"
                    "options 必须是 2 至 6 个对象，每个对象只能包含 key 和 text；key 只能是 A-F，text 必须是非空字符串。"
                    "answer_key 必须引用该题 options 中已有的 key。"
                ),
            )
        except ModelGatewayError as error:
            path_summary = ", ".join(error.validation_paths[:8])
            suffix = f" 校验路径: {path_summary}" if path_summary else ""
            raise ModelGatewayError(
                "POSTTEST_OUTPUT_INVALID",
                f"节点后测结果不符合题集合同。{suffix}",
                retryable=False,
            ) from error
        if len(question_set.questions) != value.question_count:
            raise ModelGatewayError("POSTTEST_QUESTION_COUNT_INVALID", "节点后测题目数量与请求不一致。", retryable=False)

        persisted = await internal.persist_assessment(
            agent_run_id=state.run_id,
            payload={
                "kind": value.kind,
                "question_count": value.question_count,
                "difficulty": value.difficulty,
                "plan_id": None,
                "plan_node_id": value.plan_node_id,
                "source_card_content_id": value.source_card_content_id,
                "schema_version": question_set.schema_version,
                "questions": [question.model_dump(mode="json") for question in question_set.questions],
                "generation_metadata": {
                    "model_id": connection.model_id,
                    "source_card_content_id": value.source_card_content_id,
                },
            },
        )
        return {
            "assessment_id": str(persisted.assessment_id),
            "question_count": persisted.question_count,
            "model_id": connection.model_id,
        }

    @staticmethod
    def _build_request(
        state: AgentRunExecutionState,
        value: PosttestGenerationInput,
        content: dict[str, Any],
        connection: ModelProviderConnection,
    ) -> ModelCompletionRequest:
        """构造只基于固定节点内容的后测请求。"""
        system = (
            "你是 LearnCraft 的 Node Tutor 后测设计师。最终只输出严格 JSON。"
            "只能基于给定的节点内容和 teaching_memory 出题，不得引入外部新知识。"
            "所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。"
            "题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；JSON 字符串中的结构换行使用单层转义 \\n，不能使用双重转义 \\\\n。"
            "JSON 顶层只能包含 schema_version 和 questions；schema_version 固定为 assessment.single_choice.v1。"
            "每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。"
            "options 必须是 2 至 6 个对象；每个 options 对象只能包含 key 和 text，key 必须是 A、B、C、D、E 或 F，text 必须是非空字符串。"
            "answer_key 必须是 options 中实际存在的 key；题目数量必须严格匹配请求。"
        )
        user = (
            f"后测主题：{value.topic}\n"
            f"题目数量：{value.question_count}\n"
            f"难度：{value.difficulty}\n"
            f"固定节点内容：{content.get('foundation', '')}\n"
            f"示例：{content.get('worked_example', {})}\n"
            f"易错点：{content.get('pitfalls_debug', '')}\n"
            f"教学记忆：{content.get('teaching_memory', {})}"
        )
        return ModelCompletionRequest(
            agent_run_id=state.run_id,
            connection=connection,
            messages=(
                ModelMessage(role="system", content=system),
                ModelMessage(role="user", content=user),
            ),
            tools=(),
            tool_choice="none",
            response_format="json_object",
        )
