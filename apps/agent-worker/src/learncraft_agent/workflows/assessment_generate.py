'''前测题集生成工作流。

职责：读取 AgentRun 输入，调用账户默认模型和 Tavily MCP，并将经过校验的前测单选题集交给 Web 持久化。
主要类型：AssessmentGenerationInput、AssessmentQuestionSet、AssessmentGenerationWorkflow。
'''

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from learncraft_agent.acl.web_core_internal_client import WebCoreInternalClient
from learncraft_agent.application.ports.model_gateway import ModelCompletionRequest, ModelGatewayError, ModelMessage, ModelProviderConnection
from learncraft_agent.workflows.question_set_generation import AssessmentQuestionSet, QuestionSetGenerationPipeline
from learncraft_agent.core.config import get_settings
from learncraft_agent.infrastructure.llm.credential_decryptor import ModelCredentialDecryptor
from learncraft_agent.infrastructure.llm.openai_compatible_model_gateway import OpenAiCompatibleModelGateway
from learncraft_agent.infrastructure.llm.safe_egress_client import get_safe_model_egress_client
from learncraft_agent.infrastructure.mcp.tavily_remote_mcp import TAVILY_SEARCH_TOOL, TavilyRemoteMcpToolGateway
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import AgentRunExecutionState


class AssessmentGenerationInput(BaseModel):
    '''定义前测生成的主题、学习背景与题目数量。'''
    model_config = ConfigDict(extra='ignore', frozen=True)
    topic: str = Field(min_length=1, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=2_000)
    desired_outcome: str | None = Field(default=None, max_length=2_000)
    background: str | None = Field(default=None, max_length=4_000)
    overall_experience: str | None = Field(default=None, max_length=1_000)
    question_count: int = Field(ge=5, le=20)
    difficulty: Literal['normal', 'hard'] = 'normal'
    kind: Literal['diagnostic']

    @model_validator(mode='after')
    def validate_question_count(self) -> 'AssessmentGenerationInput':
        '''校验前测题量必须在 10-20 题范围内。'''
        if not 10 <= self.question_count <= 20:
            raise ValueError('diagnostic 题量必须为 10-20')
        return self


class AssessmentGenerationWorkflow:
    '''执行 assessment_generate 前测：模型按主题时效性自主决定是否使用 Tavily，工具总调用不超过三次。'''

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
        tool_gateway = TavilyRemoteMcpToolGateway(settings=settings, owner_id=state.owner_id)
        generation = await QuestionSetGenerationPipeline(
            model_gateway=gateway,
            tool_gateway=tool_gateway,
            max_tool_calls=settings.agent_tool_max_calls,
        ).generate(
            request,
            expected_question_count=value.question_count,
            repair_instruction='请修复题集 JSON，只返回合法 schema_version 和 questions；每道题必须严格包含 prompt、options、answer_key、explanation、skill_tags、max_score，options 必须是 {key,text} 对象数组，answer_key 必须引用已有选项。',
            final_instruction='请执行题集最终恢复。可以使用 Tavily 获取可靠资料，但最终只返回 assessment.single_choice.v1 合法 JSON；题目数量必须严格匹配，每个 options 必须是 {key,text} 对象数组。',
            repair_with_tavily=False,
            final_with_tavily=True,
        )
        question_set = generation.question_set

        persisted = await internal.persist_assessment(
            agent_run_id=state.run_id,
            payload={
                'kind': value.kind,
                'question_count': value.question_count,
                'difficulty': value.difficulty,
                'plan_id': None,
                'schema_version': question_set.schema_version,
                'questions': [question.model_dump(mode='json') for question in question_set.questions],
                'generation_metadata': {
                    'topic': value.topic,
                    'model_id': connection.model_id,
                    'tool_call_count': generation.tool_call_count,
                    'search_extract': 'tavily_search_then_extract' if generation.tool_call_count else 'not_used',
                    'recovery_stage': generation.recovery_stage,
                },
            },
        )
        return {'assessment_id': str(persisted.assessment_id), 'status': persisted.status, 'question_count': persisted.question_count, 'tool_call_count': generation.tool_call_count, 'recovery_stage': generation.recovery_stage, 'model_id': connection.model_id}

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
