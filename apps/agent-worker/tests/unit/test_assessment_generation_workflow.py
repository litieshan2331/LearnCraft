'''前测生成工作流的自主联网策略测试。

测试职责：
- 验证前测请求保留 Tavily 工具定义；
- 验证首轮使用 auto，由模型自行判断是否联网；
- 验证系统提示词明确版本性、时效性与不确定性下的检索条件。
'''

from uuid import uuid4

import pytest

from pydantic import SecretStr, ValidationError

from learncraft_agent.application.ports.model_gateway import ModelProviderConnection
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    AgentRunExecutionState,
)
from learncraft_agent.workflows.assessment_generate import (
    AssessmentGenerationInput,
    AssessmentQuestionSet,
    AssessmentGenerationWorkflow,
)


def test_assessment_request_allows_model_to_decide_tavily_usage() -> None:
    '''前测首轮应提供 Tavily，但不再强制产生工具调用。'''
    state = AgentRunExecutionState(
        run_id=uuid4(),
        owner_id=uuid4(),
        run_type='assessment_generate',
        target_type='learning_goal',
        target_id=uuid4(),
        input_summary_json={},
        status='running',
        should_execute=True,
    )
    value = AssessmentGenerationInput(
        topic='TypeScript 类型系统',
        question_count=10,
        kind='diagnostic',
    )
    connection = ModelProviderConnection(
        owner_id=state.owner_id,
        connection_id=uuid4(),
        base_url='https://api.deepseek.com',
        model_id='deepseek-v4-flash',
        api_key=SecretStr('test-key'),
    )

    request = AssessmentGenerationWorkflow._build_request(state, value, connection)

    assert request.tool_choice == 'auto'
    assert request.stream is True
    assert request.response_format == 'json_object'
    assert request.tools[0].name == 'tavily_search'
    assert request.messages[0].content is not None
    assert '近期版本' in request.messages[0].content
    assert '不要为调用工具而调用工具' in request.messages[0].content
    assert 'schema_version' in request.messages[0].content
    assert 'questions' in request.messages[0].content
    assert '简体中文' in request.messages[0].content
    assert '双重转义' in request.messages[0].content


def test_assessment_input_rejects_post_test_kind() -> None:
    '''前测工作流不再接受 post_test 题集类型。'''
    with pytest.raises(ValidationError):
        AssessmentGenerationInput(
            topic='TypeScript 类型系统',
            question_count=5,
            kind='post_test',
        )


def test_assessment_question_set_normalizes_double_escaped_markdown_newlines() -> None:
    '''整段题干被双重转义时应在入库前还原结构换行，代码字符串的转义语义不变。'''
    source_question = {
        'prompt': r'请阅读这段 TypeScript 代码：\n\n```ts\nconst separator = "\\n";\n```',
        'options': [
            {'key': 'A', 'text': '第一个选项'},
            {'key': 'B', 'text': '第二个选项'},
        ],
        'answer_key': 'A',
        'explanation': r'代码中的换行展示如下：\n\n```ts\nconsole.log("ok");\n```',
        'skill_tags': ['TypeScript'],
        'max_score': 1,
    }

    question_set = AssessmentQuestionSet.model_validate({
        'questions': [source_question for _ in range(5)],
    })

    question = question_set.questions[0]
    assert question.prompt == '请阅读这段 TypeScript 代码：\n\n```ts\nconst separator = "\\n";\n```'
    assert question.explanation == '代码中的换行展示如下：\n\n```ts\nconsole.log("ok");\n```'
