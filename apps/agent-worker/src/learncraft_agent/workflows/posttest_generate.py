"""节点后测生成工作流。

主要类型：
- PosttestGenerationInput：后测任务输入快照。
- PosttestQuestionSet：兼容旧导入路径的共用题集合同别名。
- PosttestWorkflow：读取固定 CardContent 和 teaching_memory，生成并回写后测。
"""

from __future__ import annotations

from typing import Any, Literal

import orjson

from pydantic import BaseModel, ConfigDict, Field, ValidationError

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
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import TavilyRemoteMcpToolGateway
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState

from learncraft_agent.workflows.question_set_generation import (
    AssessmentQuestionSet,
    QuestionSetGenerationPipeline,
)

PosttestQuestionSet = AssessmentQuestionSet


class PosttestGenerationInput(BaseModel):
    """表示 Web 冻结的节点后测请求。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    topic: str = Field(min_length=1, max_length=300)
    question_count: int = Field(ge=5, le=10)
    difficulty: Literal["normal", "hard"] = "normal"
    kind: Literal["post_test"]
    plan_node_id: str = Field(min_length=1, max_length=64)
    source_card_content_id: str = Field(min_length=1, max_length=64)


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
        tool_gateway = TavilyRemoteMcpToolGateway(settings=settings, owner_id=state.owner_id)
        request = self._build_request(state, value, content.model_dump(mode="json"), connection)
        try:
            generation = await QuestionSetGenerationPipeline(
                model_gateway=gateway,
                tool_gateway=tool_gateway,
                max_tool_calls=settings.agent_tool_max_calls,
            ).generate(
                request,
                expected_question_count=value.question_count,
                repair_instruction=(
                    "后测输出校验失败。请基于原节点内容重新输出严格 JSON。"
                    "本阶段可以根据需要调用 tavily_search，但 CardContent 和 teaching_memory 仍必须是主要出题依据。"
                    "不要 Markdown、解释文字或额外字段；顶层只能是 schema_version 和 questions。"
                    "schema_version 必须精确为 assessment.single_choice.v1，题目数量必须严格匹配请求。"
                    "每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。"
                    "options 必须是 2 至 6 个 {key,text} 对象，key 只能是 A-F，answer_key 必须引用已有选项。"
                ),
                final_instruction=(
                    "后测最终恢复阶段。请保留 CardContent 和 teaching_memory 作为出题依据；"
                    "必要时可以调用 tavily_search 核对资料。最终只返回严格 JSON，"
                    "顶层只能是 schema_version、questions，schema_version 必须是 assessment.single_choice.v1；"
                    "题目数量必须严格匹配请求，每题的 options 必须是 {key,text} 对象数组，"
                    "answer_key 必须引用已有选项，不要输出解释文字或额外字段。"
                ),
                repair_with_tavily=True,
                final_with_tavily=True,
            )
            question_set = generation.question_set
        except ModelGatewayError as error:
            if error.code != "MODEL_STRUCTURED_OUTPUT_INVALID":
                raise
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
                    "tool_call_count": generation.tool_call_count,
                    "recovery_stage": generation.recovery_stage,
                },
            },
        )
        return {
            "assessment_id": str(persisted.assessment_id),
            "question_count": persisted.question_count,
            "tool_call_count": generation.tool_call_count,
            "recovery_stage": generation.recovery_stage,
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
            f"固定节点内容(JSON)：{orjson.dumps(content).decode('utf-8')}"
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
