"""前测与后测共用的题集生成管线。

主要类型：
- AssessmentOption、AssessmentQuestion、AssessmentQuestionSet：共用题集输出合同。
- QuestionSetGenerationPipeline：执行首轮生成、结构化修复和 Tavily 恢复。
- _extract_json_text、_normalize_double_escaped_markdown_newlines：提取模型 JSON 并规范化题干和解析中的 Markdown 换行。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from learncraft_agent.application.ports.model_gateway import (
    ModelCompletionRequest,
    ModelGateway,
    ModelGatewayError,
    ModelMessage,
)
from learncraft_agent.application.ports.tool_gateway import ToolGateway
from learncraft_agent.application.services.tool_aware_generator import ToolAwareGenerator
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import TAVILY_SEARCH_TOOL


class AssessmentOption(BaseModel):
    """表示单选题的一个选项。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str = Field(min_length=1, max_length=1, pattern=r"^[A-F]$")
    text: str = Field(min_length=1, max_length=500)


class AssessmentQuestion(BaseModel):
    """表示可确定性评分的单选题。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    prompt: str = Field(min_length=1, max_length=2_000)
    options: list[AssessmentOption] = Field(min_length=2, max_length=6)
    answer_key: str = Field(min_length=1, max_length=1, pattern=r"^[A-F]$")
    explanation: str = Field(min_length=1, max_length=2_000)
    skill_tags: list[str] = Field(default_factory=list, max_length=10)
    max_score: float = Field(default=1, gt=0, le=100)

    @field_validator("prompt", "explanation")
    @classmethod
    def normalize_markdown_newlines(cls, value: str) -> str:
        """在持久化前规范化 Markdown 双重换行转义。"""
        return _normalize_double_escaped_markdown_newlines(value)

    @model_validator(mode="after")
    def validate_answer_key(self) -> "AssessmentQuestion":
        """确保正确选项确实存在于题目选项中。"""
        if self.answer_key not in {option.key for option in self.options}:
            raise ValueError("answer_key 必须引用已有选项")
        return self


class AssessmentQuestionSet(BaseModel):
    """表示前测和后测共用的稳定题集输出合同。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["assessment.single_choice.v1"] = "assessment.single_choice.v1"
    questions: list[AssessmentQuestion] = Field(min_length=5, max_length=20)


class QuestionSetGenerationResult(BaseModel):
    """表示题集管线最终结果和内部工具调用摘要。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    question_set: AssessmentQuestionSet
    tool_call_count: int = Field(ge=0)
    recovery_stage: Literal["initial", "repair", "tavily_recovery"]


class QuestionSetGenerationPipeline:
    """执行题集首轮生成、修复和联网恢复，不负责业务持久化。"""

    def __init__(
        self,
        *,
        model_gateway: ModelGateway,
        tool_gateway: ToolGateway,
        max_tool_calls: int,
    ) -> None:
        self._model_gateway = model_gateway
        self._tool_gateway = tool_gateway
        self._max_tool_calls = max_tool_calls

    async def generate(
        self,
        request: ModelCompletionRequest,
        *,
        expected_question_count: int,
        repair_instruction: str,
        final_instruction: str,
        repair_with_tavily: bool,
        final_with_tavily: bool,
    ) -> QuestionSetGenerationResult:
        """执行首轮、修复和最终恢复；全部失败时返回脱敏结构化错误。"""
        tool_call_count = 0
        content = ""
        paths: list[str] = []
        last_error: ModelGatewayError | None = None
        stages = ("initial", "repair", "tavily_recovery")
        for stage in stages:
            stage_request = request if stage == "initial" else self._recovery_request(
                request,
                content,
                repair_instruction if stage == "repair" else final_instruction,
                with_tavily=repair_with_tavily if stage == "repair" else final_with_tavily,
            )
            try:
                candidate, calls = await self._complete(stage_request)
            except ModelGatewayError as error:
                last_error = error
                paths = list(error.validation_paths) or paths
                continue
            content = candidate
            tool_call_count += calls
            value, paths = self._validate(content, expected_question_count)
            if value is not None:
                return QuestionSetGenerationResult(
                    question_set=value,
                    tool_call_count=tool_call_count,
                    recovery_stage=stage,
                )

        if last_error is not None and last_error.code != "MODEL_STRUCTURED_OUTPUT_INVALID":
            raise last_error
        paths = paths or ["response.json"]
        raise ModelGatewayError(
            "MODEL_STRUCTURED_OUTPUT_INVALID",
            f"题集结果经过恢复后仍不符合合同。校验路径: {', '.join(paths[:8])}",
            retryable=False,
            validation_paths=tuple(paths[:8]),
        )

    async def _complete(self, request: ModelCompletionRequest) -> tuple[str, int]:
        """执行一次模型请求；有工具时复用统一工具循环。"""
        if request.tools:
            result = await ToolAwareGenerator(
                model_gateway=self._model_gateway,
                tool_gateway=self._tool_gateway,
                max_tool_calls=self._max_tool_calls,
            ).generate(request)
            return result.content, result.tool_call_count

        response = await self._model_gateway.complete(request)
        if response.message.tool_calls or not response.message.content:
            raise ModelGatewayError(
                "MODEL_STRUCTURED_OUTPUT_INVALID",
                "模型没有返回可校验的结构化文本结果。",
                retryable=False,
                validation_paths=("response.content_missing",),
            )
        return response.message.content, 0

    def _validate(
        self,
        content: str,
        expected_question_count: int,
    ) -> tuple[AssessmentQuestionSet | None, list[str]]:
        """解析并校验题集，记录字段路径但不记录模型正文。"""
        try:
            value = AssessmentQuestionSet.model_validate_json(
                _extract_json_text(content),
            )
            if len(value.questions) != expected_question_count:
                return None, ["questions"]
            return value, []
        except (ValidationError, ValueError) as error:
            return None, self._validation_paths(error)

    @staticmethod
    def _recovery_request(
        request: ModelCompletionRequest,
        previous_content: str,
        instruction: str,
        *,
        with_tavily: bool,
    ) -> ModelCompletionRequest:
        """构造带脱敏校验要求的修复或最终恢复请求。"""
        tools = (TAVILY_SEARCH_TOOL,) if with_tavily else ()
        return request.model_copy(
            update={
                "messages": request.messages + (
                    ModelMessage(role="assistant", content=previous_content),
                    ModelMessage(role="system", content=instruction),
                ),
                "tools": tools,
                "tool_choice": "auto" if with_tavily else "none",
            },
        )

    @staticmethod
    def _validation_paths(error: ValidationError | ValueError) -> list[str]:
        """只提取校验字段路径，不记录模型原文。"""
        if isinstance(error, ValidationError):
            paths: list[str] = []
            for item in error.errors():
                location = item.get("loc", ())
                path = ".".join(str(part) for part in location)
                if path and path not in paths:
                    paths.append(path)
            return paths
        return ["response.json"]


def _extract_json_text(content: str) -> str:
    """兼容少数 Provider 返回的 JSON 代码块。"""
    normalized = content.strip()
    if normalized.startswith("```json") and normalized.endswith("```"):
        return normalized[7:-3].strip()
    if normalized.startswith("```") and normalized.endswith("```"):
        return normalized[3:-3].strip()
    return normalized


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
