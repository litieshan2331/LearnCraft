"""AgentRun 的 Celery 执行命令。

类：
- RetryableAgentRunError：适合由 Celery 延迟重试的临时错误。
- NonRetryableAgentRunError：应立即持久化为失败的确定性错误。

函数：
- execute_agent_run：领取运行、检查协作式取消，并委派给后续 LangGraph 工作流。
"""

from learncraft_agent.acl.web_core_internal_client import CoreInternalClientError
from learncraft_agent.application.dto.agent_run_task import AgentRunRequestedTask
from learncraft_agent.application.services.base_agent import AgentWorkflowNotRegisteredError
from learncraft_agent.application.services.learning_architect_agent import LearningArchitectAgent
from learncraft_agent.application.ports.model_gateway import ModelGatewayError
from learncraft_agent.infrastructure.llm.credential_decryptor import CredentialDecryptionError
from learncraft_agent.infrastructure.persistence.repositories.sqlalchemy_agent_run_repository import (
    SqlAlchemyAgentRunRepository,
)


class RetryableAgentRunError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
    """表示模型限流、网络超时等可恢复的执行错误。"""


class NonRetryableAgentRunError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
    """表示载荷、版本或未注册工作流等不可通过重试解决的错误。"""


async def execute_agent_run(
    *,
    task: AgentRunRequestedTask,
    retry_count: int,
    repository: SqlAlchemyAgentRunRepository,
) -> None:
    """执行任务生命周期前置步骤，并为后续 LangGraph 工作流保留唯一入口。"""
    execution_state = await repository.begin_execution(
        run_id=task.agent_run_id,
        trace_id=task.trace_id,
        retry_count=retry_count,
    )
    if not execution_state.should_execute:
        return
    if await repository.is_cancelled(task.agent_run_id):
        return

    try:
        result = await LearningArchitectAgent().run(execution_state)
        await repository.mark_succeeded(
            run_id=execution_state.run_id,
            output_summary=result,
            actual_model_profile=str(result.get('model_id')) if result.get('model_id') else None,
        )
        return
    except AgentWorkflowNotRegisteredError as error:
        raise NonRetryableAgentRunError(
            'AGENT_RUN_WORKFLOW_NOT_REGISTERED',
            str(error),
        ) from error
    except ModelGatewayError as error:
        if error.retryable:
            raise RetryableAgentRunError(error.code, str(error)) from error
        raise NonRetryableAgentRunError(error.code, str(error)) from error
    except CoreInternalClientError as error:
        if error.retryable:
            raise RetryableAgentRunError(error.code, str(error)) from error
        raise NonRetryableAgentRunError(error.code, str(error)) from error
    except CredentialDecryptionError as error:
        raise NonRetryableAgentRunError(error.code, str(error)) from error
