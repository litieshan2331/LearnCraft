/**
 * AgentRun 执行命令（等价于 Python 的 application/commands/execute_agent_run.py 与 Celery 任务的重试策略）。
 *
 * 职责：
 * 1. 领取运行（行锁 + 状态机）、检查协作式取消、按 run_type 路由到已注册工作流；
 * 2. 把工作流结果写入成功状态，**并把真实 token 用量写入 agent_runs**（已确认的与 Python 差异）；
 * 3. 把异常归类为可重试或不可重试，并提供队列侧的重试/失败策略（退避与重试耗尽）。
 *
 * 错误码与 Python 一致：AGENT_RUN_WORKFLOW_NOT_REGISTERED、AGENT_RUN_RETRY_EXHAUSTED、
 * AGENT_RUN_UNEXPECTED_ERROR；业务错误码透传 ModelGatewayError / CoreInternalClientError /
 * CredentialDecryptionError 的 code。
 *
 * 导出：
 * - AgentRunTask：队列消息 DTO（agent_run_id / trace_id / task_version=1）。
 * - RetryableAgentRunError / NonRetryableAgentRunError：可重试与不可重试的分类异常。
 * - AgentWorkflowNotRegisteredError：run_type 未注册。
 * - AgentWorkflow / AgentWorkflowResult / AgentRunRepositoryPort / WorkflowRegistryPort。
 * - executeAgentRun：执行一次 AgentRun（返回 skipped 或 succeeded）。
 * - calculateRetryDelaySeconds：10/20/40… 封顶 300 秒的退避。
 * - handleAgentRunFailure：队列侧的重试或最终失败处理。
 */

import type { AgentRunExecutionState } from '../../infrastructure/database/agent-run-repository.js';
import { CoreInternalClientError } from '../../acl/core-internal-client.js';
import { CredentialDecryptionError } from '../../infrastructure/llm/credential-decryptor.js';
import { ModelGatewayError } from '../../infrastructure/llm/model-gateway.js';

export const AGENT_RUN_RETRY_EXHAUSTED = 'AGENT_RUN_RETRY_EXHAUSTED';
export const AGENT_RUN_UNEXPECTED_ERROR = 'AGENT_RUN_UNEXPECTED_ERROR';
export const AGENT_RUN_WORKFLOW_NOT_REGISTERED = 'AGENT_RUN_WORKFLOW_NOT_REGISTERED';

export interface AgentRunTask {
  agentRunId: string;
  traceId: string;
  taskVersion: 1;
}

export class RetryableAgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetryableAgentRunError';
  }
}

export class NonRetryableAgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NonRetryableAgentRunError';
  }
}

export class AgentWorkflowNotRegisteredError extends Error {
  constructor(readonly runType: string) {
    super('尚未注册 run_type=' + runType + ' 的 Agent 工作流。');
    this.name = 'AgentWorkflowNotRegisteredError';
  }
}

export interface AgentWorkflowResult {
  /** 写入 agent_runs.output_summary_json 的摘要；键集合必须与对应 Python 工作流一致。 */
  outputSummary: Record<string, unknown>;
  /** 跨阶段累计的真实 token 用量；调用方必须写入 token 列（与 Python 恒定写 0 的差异）。 */
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentWorkflow {
  run(executionState: AgentRunExecutionState): Promise<AgentWorkflowResult>;
}

export interface WorkflowRegistryPort {
  /** 返回已注册的工作流；未注册时返回 null（由命令层转为不可重试错误）。 */
  resolve(runType: string): AgentWorkflow | null;
}

export interface AgentRunRepositoryPort {
  beginExecution(input: { runId: string; traceId: string; retryCount: number }): Promise<AgentRunExecutionState>;
  isCancelled(runId: string): Promise<boolean>;
  markSucceeded(input: {
    runId: string;
    outputSummary: Record<string, unknown>;
    inputTokens?: number;
    outputTokens?: number;
    actualModelProfile?: string | null;
  }): Promise<void>;
  markFailed(input: { runId: string; errorCode: string; errorSummary: string }): Promise<void>;
  markRetryScheduled(input: {
    runId: string;
    retryCount: number;
    delaySeconds: number;
    errorCode: string;
  }): Promise<void>;
}

export type ExecuteAgentRunOutcome =
  | { status: 'skipped'; reason: 'already_finished' | 'cancelled' }
  | { status: 'succeeded'; runId: string };

/**
 * 执行一次 AgentRun：领取 → 取消检查 → 路由 → 执行 → 回写成功。
 * 失败时抛出已归类的错误，由 handleAgentRunFailure 决定重试或最终失败。
 */
export async function executeAgentRun(input: {
  task: AgentRunTask;
  retryCount: number;
  repository: AgentRunRepositoryPort;
  workflows: WorkflowRegistryPort;
}): Promise<ExecuteAgentRunOutcome> {
  const executionState = await input.repository.beginExecution({
    runId: input.task.agentRunId,
    traceId: input.task.traceId,
    retryCount: input.retryCount,
  });
  if (!executionState.shouldExecute) {
    return { status: 'skipped', reason: 'already_finished' };
  }
  if (await input.repository.isCancelled(input.task.agentRunId)) {
    return { status: 'skipped', reason: 'cancelled' };
  }

  try {
    const workflow = input.workflows.resolve(executionState.runType);
    if (workflow === null) {
      throw new AgentWorkflowNotRegisteredError(executionState.runType);
    }
    const result = await workflow.run(executionState);
    const modelId = result.outputSummary.model_id;
    await input.repository.markSucceeded({
      runId: executionState.runId,
      outputSummary: result.outputSummary,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      actualModelProfile: typeof modelId === 'string' && modelId.length > 0 ? modelId : null,
    });
    return { status: 'succeeded', runId: executionState.runId };
  } catch (error) {
    throw classifyExecutionError(error);
  }
}

/** 把工作流异常归类为可重试或不可重试；未识别的异常原样上抛（由失败策略归为未分类错误）。 */
function classifyExecutionError(error: unknown): unknown {
  if (error instanceof AgentWorkflowNotRegisteredError) {
    return new NonRetryableAgentRunError(AGENT_RUN_WORKFLOW_NOT_REGISTERED, error.message);
  }
  if (error instanceof ModelGatewayError) {
    return error.retryable
      ? new RetryableAgentRunError(error.code, error.message)
      : new NonRetryableAgentRunError(error.code, error.message);
  }
  if (error instanceof CoreInternalClientError) {
    return error.retryable
      ? new RetryableAgentRunError(error.code, error.message)
      : new NonRetryableAgentRunError(error.code, error.message);
  }
  if (error instanceof CredentialDecryptionError) {
    return new NonRetryableAgentRunError(error.code, error.message);
  }
  return error;
}

/** 按照已批准的 10/20/40… 秒策略计算有上限的指数退避（等价于 Python 实现）。 */
export function calculateRetryDelaySeconds(
  nextRetryCount: number,
  backoffSeconds = 10,
  maxBackoffSeconds = 300,
): number {
  return Math.min(maxBackoffSeconds, backoffSeconds * 2 ** Math.max(0, nextRetryCount - 1));
}

export type AgentRunFailureOutcome =
  | { action: 'retry'; delaySeconds: number; retryCount: number }
  | { action: 'failed'; code: string };

/**
 * 队列侧的失败处理（等价于 Python Celery 任务的 except 分支）：
 * 可重试且未耗尽 → 记录下一次重试并返回延迟；否则写入最终失败状态。
 */
export async function handleAgentRunFailure(input: {
  runId: string;
  retryCount: number;
  maxRetries: number;
  error: unknown;
  repository: AgentRunRepositoryPort;
}): Promise<AgentRunFailureOutcome> {
  const { error } = input;

  if (error instanceof RetryableAgentRunError) {
    if (input.retryCount >= input.maxRetries) {
      await input.repository.markFailed({
        runId: input.runId,
        errorCode: AGENT_RUN_RETRY_EXHAUSTED,
        errorSummary: error.message,
      });
      return { action: 'failed', code: AGENT_RUN_RETRY_EXHAUSTED };
    }
    const nextRetryCount = input.retryCount + 1;
    const delaySeconds = calculateRetryDelaySeconds(nextRetryCount);
    await input.repository.markRetryScheduled({
      runId: input.runId,
      retryCount: nextRetryCount,
      delaySeconds,
      errorCode: error.code,
    });
    return { action: 'retry', delaySeconds, retryCount: nextRetryCount };
  }

  if (error instanceof NonRetryableAgentRunError) {
    await input.repository.markFailed({
      runId: input.runId,
      errorCode: error.code,
      errorSummary: error.message,
    });
    return { action: 'failed', code: error.code };
  }

  const summary = error instanceof Error ? error.message : String(error);
  await input.repository.markFailed({
    runId: input.runId,
    errorCode: AGENT_RUN_UNEXPECTED_ERROR,
    errorSummary: summary,
  });
  return { action: 'failed', code: AGENT_RUN_UNEXPECTED_ERROR };
}
