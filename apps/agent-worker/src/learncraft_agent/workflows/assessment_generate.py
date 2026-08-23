'''前测与后测题集生成工作流。

职责：读取 AgentRun 输入，调用账户默认模型和 Tavily MCP，并将经过校验的单选题集交给 Web 持久化。
主要类型：AssessmentGenerationInput、AssessmentQuestionSet、AssessmentGenerationWorkflow。
'''

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from learncraft_agent.acl.web_core_internal_client import WebCoreInternalClient
from learncraft_agent.application.ports.model_gateway import ModelCompletionRequest, ModelGatewayError, ModelMessage, ModelProviderConnection
from learncraft_agent.application.services.tool_aware_generator import ToolAwareGenerator
from learncraft_agent.core.config import get_settings
from learncraft_agent.infrastructure.llm.credential_decryptor import ModelCredentialDecryptor
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import OpenAiCompatibleModelGateway
from learncraft_agent.infrastructure.llm.safe_egress_client import get_safe_model_egress_client
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import TAVILY_SEARCH_TOOL, TavilyRemoteMcpToolGateway
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState


def _normalize_double_escaped_markdown_newlines(value: str) -> str:
    '''还原整段 Markdown 中被模型双重转义的结构换行，同时保留代码字符串自己的转义语义。'''
    if '\n' in value or r'\n' not in value or '```' not in value:
        return value

    normalized: list[str] = []
    index = 0
    while index < len(value):
        if value.startswith(r'\r\n', index):
            normalized.append('\n')
            index += 4
            continue
        if value.startswith(r'\n', index):
            normalized.append('\n')
            index += 2
            continue
        if value.startswith(r'\\', index):
            normalized.append('\\')
            index += 2
            continue
        normalized.append(value[index])
        index += 1
    return ''.join(normalized)


class AssessmentGenerationInput(BaseModel):
    '''定义前测或后测生成的开放式主题与数量。'''
    model_config = ConfigDict(extra='ignore', frozen=True)
    topic: str = Field(min_length=1, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=2_000)
    desired_outcome: str | None = Field(default=None, max_length=2_000)
    background: str | None = Field(default=None, max_length=4_000)
    overall_experience: str | None = Field(default=None, max_length=1_000)
    question_count: int = Field(ge=5, le=20)
    difficulty: Literal['normal', 'hard'] = 'normal'
    kind: Literal['diagnostic', 'post_test']
    plan_id: UUID | None = None

    @model_validator(mode='after')
    def validate_question_count(self) -> 'AssessmentGenerationInput':
        '''按前测或后测的产品约束校验题量。'''
        if self.kind == 'diagnostic' and not 10 <= self.question_count <= 20:
            raise ValueError('diagnostic 题量必须为 10-20')
        if self.kind == 'post_test' and not 5 <= self.question_count <= 10:
            raise ValueError('post_test 题量必须为 5-10')
        return self


class AssessmentOption(BaseModel):
    '''表示单选题的一个选项。'''
    model_config = ConfigDict(extra='forbid', frozen=True)
    key: str = Field(min_length=1, max_length=1, pattern=r'^[A-F]$')
    text: str = Field(min_length=1, max_length=500)


class AssessmentQuestion(BaseModel):
    '''表示可确定性评分的单选题。'''
    model_config = ConfigDict(extra='forbid', frozen=True)
    prompt: str = Field(min_length=1, max_length=2_000)
    options: list[AssessmentOption] = Field(min_length=2, max_length=6)
    answer_key: str = Field(min_length=1, max_length=1, pattern=r'^[A-F]$')
    explanation: str = Field(min_length=1, max_length=2_000)
    skill_tags: list[str] = Field(default_factory=list, max_length=10)
    max_score: float = Field(default=1, gt=0, le=100)
    @field_validator('prompt', 'explanation')
    @classmethod
    def normalize_markdown_newlines(cls, value: str) -> str:
        '''在持久化前规范化整段 Markdown 的双重换行转义，不因该格式问题阻断入库。'''
        return _normalize_double_escaped_markdown_newlines(value)


    @model_validator(mode='after')
    def validate_answer_key(self) -> 'AssessmentQuestion':
        '''确保正确选项确实存在于题目选项中。'''
        if self.answer_key not in {option.key for option in self.options}:
            raise ValueError('answer_key 必须引用已有选项')
        return self


class AssessmentQuestionSet(BaseModel):
    '''表示题集生成的稳定输出合同。'''
    model_config = ConfigDict(extra='forbid', frozen=True)
    schema_version: Literal['assessment.single_choice.v1'] = 'assessment.single_choice.v1'
    questions: list[AssessmentQuestion] = Field(min_length=5, max_length=20)


class AssessmentGenerationWorkflow:
    '''执行 assessment_generate：模型按主题时效性自主决定是否使用 Tavily，工具总调用不超过三次。'''

    async def run(self, state: AgentRunExecutionState) -> dict[str, Any]:
        '''生成并持久化题集，返回 AgentRun 输出摘要。'''
        settings = get_settings()
        try:
            value = AssessmentGenerationInput.model_validate(state.input_summary_json)
        except ValidationError as error:
            raise ModelGatewayError('ASSESSMENT_INPUT_INVALID', '题集生成输入不符合契约。', retryable=False) from error

        internal = WebCoreInternalClient(base_url=settings.core_internal_base_url, internal_service_secret=settings.internal_service_secret)
        envelope = await internal.get_default_model_connection(state.run_id)
        api_key = ModelCredentialDecryptor(encryption_key=settings.credential_encryption_key, key_version=settings.credential_encryption_key_version).decrypt(owner_id=envelope.owner_id, credential=envelope.credential)
        connection = ModelProviderConnection(owner_id=envelope.owner_id, connection_id=envelope.connection_id, base_url=envelope.base_url, model_id=envelope.model_id, api_key=api_key)
        gateway = OpenAiCompatibleModelGateway(egress_client=get_safe_model_egress_client(), request_max_retries=settings.model_gateway_request_max_retries)
        request = self._build_request(state, value, connection)
        generation = await ToolAwareGenerator(model_gateway=gateway, tool_gateway=TavilyRemoteMcpToolGateway(settings=settings, owner_id=state.owner_id), max_tool_calls=settings.agent_tool_max_calls).generate(request)
        question_set = await self._parse_or_repair(gateway=gateway, request=request, content=generation.content)
        if len(question_set.questions) != value.question_count:
            raise ModelGatewayError('ASSESSMENT_QUESTION_COUNT_INVALID', '模型返回的题目数量与请求不一致。', retryable=False)

        persisted = await internal.persist_assessment(
            agent_run_id=state.run_id,
            payload={
                'kind': value.kind,
                'question_count': value.question_count,
                'difficulty': value.difficulty,
                'plan_id': str(value.plan_id) if value.plan_id else None,
                'schema_version': question_set.schema_version,
                'questions': [question.model_dump(mode='json') for question in question_set.questions],
                'generation_metadata': {
                    'topic': value.topic,
                    'model_id': connection.model_id,
                    'tool_call_count': generation.tool_call_count,
                    'search_extract': 'tavily_search_then_extract' if generation.tool_call_count else 'not_used',
                },
            },
        )
        return {'assessment_id': str(persisted.assessment_id), 'status': persisted.status, 'question_count': persisted.question_count, 'tool_call_count': generation.tool_call_count, 'model_id': connection.model_id}

    @staticmethod
    def _build_request(state: AgentRunExecutionState, value: AssessmentGenerationInput, connection: ModelProviderConnection) -> ModelCompletionRequest:
        '''构造允许模型按主题时效性自主使用搜索，并最终输出 JSON 的模型请求。'''
        empty = ''
        system = (
            '你是 LearnCraft 程序员学习评估题目设计师。题目必须是单选题，最终只输出一个严格 JSON 对象，不要输出对象外的 Markdown 或解释文字。'
            '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。'
            '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；语言标签、代码、命令和标识符保持英文。'
            'JSON 字符串中的结构换行必须使用单层转义 \\n，绝不能使用双重转义 \\\\n；代码中原本需要表示换行字符时保留其自身的转义语义。'
            '当主题涉及近期版本、快速变化的 API、兼容性、官方规范，或你对事实没有足够把握时，使用 tavily_search 获取可靠资料。'
            '对于稳定且你有足够把握的基础知识，可直接生成题目；不要为调用工具而调用工具。'
            'JSON 顶层只能包含 schema_version 和 questions：schema_version 固定为 assessment.single_choice.v1；questions 必须是题目数组。'
            '每道题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。'
            'options 必须是 2 至 6 个对象，每个对象只能包含 key 和 text；answer_key 必须是 options 中存在的 A 至 F 键；max_score 必须为正数。'
        )
        lines = [
            f'主题：{value.topic}',
            f'标题：{value.title or value.topic}',
            f'描述：{value.description or empty}',
            f'目标：{value.desired_outcome or empty}',
            f'整体编程经验：{value.overall_experience or empty}',
            f'测试类型：{value.kind}',
            f'难度：{value.difficulty}',
            f'请生成恰好 {value.question_count} 道题，每题包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
        ]
        user = '\n'.join(lines)
        messages = (ModelMessage(role='system', content=system), ModelMessage(role='user', content=user))
        return ModelCompletionRequest(
            agent_run_id=state.run_id,
            connection=connection,
            messages=messages,
            tools=(TAVILY_SEARCH_TOOL,),
            tool_choice='auto',
            response_format='json_object',
        )

    @staticmethod
    async def _parse_or_repair(*, gateway: OpenAiCompatibleModelGateway, request: ModelCompletionRequest, content: str) -> AssessmentQuestionSet:
        '''先本地校验；失败时用无工具修复请求，避免重复消耗 Tavily。'''
        try:
            return AssessmentQuestionSet.model_validate_json(gateway._extract_json_text(content))
        except (ValidationError, ValueError):
            repair_messages = request.messages + (ModelMessage(role='assistant', content=content), ModelMessage(role='system', content='请只返回符合 schema 的合法 JSON，修复字段错误。'))
            repair_request = request.model_copy(update={'messages': repair_messages, 'tools': (), 'tool_choice': 'none'})
            return await gateway.complete_structured(repair_request, AssessmentQuestionSet)
