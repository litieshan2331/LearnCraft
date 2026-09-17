/**
 * 命令层测试：执行、路由、错误归类，以及队列侧的重试与失败策略。
 *
 * 重点固化：
 * - 已终态或已取消的运行不执行任何工作流；
 * - 成功时**把真实 token 用量写入 agent_runs**（与 Python 恒定写 0 的已确认差异）；
 * - 未注册 run_type、Provider 错误、内部接口错误、凭据解密失败的错误码与可重试性；
 * - 退避公式 10/20/40… 封顶 300，以及重试耗尽后的 AGENT_RUN_RETRY_EXHAUSTED。
 */
import { describe, expect, it } from 'vitest';

import { CoreInternalClientError } from '../src/acl/core-internal-client.js';
import {
  AGENT_RUN_RETRY_EXHAUSTED,
  AGENT_RUN_UNEXPECTED_ERROR,
  AGENT_RUN_WORKFLOW_NOT_REGISTERED,
  NonRetryableAgentRunError,
  RetryableAgentRunError,
  calculateRetryDelaySeconds,
  executeAgentRun,
  handleAgentRunFailure,
  type AgentRunRepositoryPort,
  type AgentWorkflow,
} from '../src/application/commands/execute-agent-run.js';
import { AgentWorkflowRegistry } from '../src/application/services/agent-workflow-registry.js';
import type { AgentRunExecutionState } from '../src/infrastructure/database/agent-run-repository.js';
import { CREDENTIAL_ENCRYPTION_UNAVAILABLE, CredentialDecryptionError } from '../src/infrastructure/llm/credential-decryptor.js';
import { ModelGatewayError } from '../src/infrastructure/llm/model-gateway.js';

const RUN_ID = 'run-1';
const TRACE_ID = 'trace-1';

function executionState(overrides: Partial<AgentRunExecutionState> = {}): AgentRunExecutionState {
  return {
    runId: RUN_ID,
    ownerId: 'owner-1',
    runType: 'assessment_generate',
    targetType: 'learning_goal',
    targetId: 'goal-1',
    inputSummaryJson: { topic: 'x' },
    status: 'running',
    shouldExecute: true,
    ...overrides,
  };
}

class FakeRepository implements AgentRunRepositoryPort {
  readonly succeeded: Array<Record<string, unknown>> = [];
  readonly failed: Array<Record<string, unknown>> = [];
  readonly retried: Array<Record<string, unknown>> = [];

  constructor(
    private readonly state: AgentRunExecutionState = executionState(),
    private readonly cancelled = false,
  ) {}

  async beginExecution(): Promise<AgentRunExecutionState> {
    return this.state;
  }

  async isCancelled(): Promise<boolean> {
    return this.cancelled;
  }

  async markSucceeded(input: Record<string, unknown>): Promise<void> {
    this.succeeded.push(input);
  }

  async markFailed(input: Record<string, unknown>): Promise<void> {
    this.failed.push(input);
  }

  async markRetryScheduled(input: Record<string, unknown>): Promise<void> {
    this.retried.push(input);
  }
}

function workflowOf(run: AgentWorkflow['run']): AgentWorkflow {
  return { run };
}

function registryWith(runType: string, workflow: AgentWorkflow): AgentWorkflowRegistry {
  const registry = new AgentWorkflowRegistry();
  registry.register(runType, workflow);
  return registry;
}

describe('executeAgentRun', () => {
  it('已终态的运行直接跳过，不执行工作流也不回写', async () => {
    const repository = new FakeRepository(executionState({ shouldExecute: false, status: 'succeeded' }));
    let called = false;

    const outcome = await executeAgentRun({
      task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
      retryCount: 0,
      repository,
      workflows: registryWith('assessment_generate', workflowOf(async () => {
        called = true;
        return { outputSummary: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      })),
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'already_finished' });
    expect(called).toBe(false);
    expect(repository.succeeded).toHaveLength(0);
  });

  it('已取消的运行不执行工作流', async () => {
    const repository = new FakeRepository(executionState(), true);

    const outcome = await executeAgentRun({
      task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
      retryCount: 0,
      repository,
      workflows: registryWith('assessment_generate', workflowOf(async () => {
        throw new Error('不应被调用');
      })),
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'cancelled' });
  });

  it('成功时把真实 token 用量与模型名写入运行', async () => {
    const repository = new FakeRepository();

    const outcome = await executeAgentRun({
      task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
      retryCount: 2,
      repository,
      workflows: registryWith('assessment_generate', workflowOf(async () => ({
        outputSummary: { assessment_id: 'a-1', model_id: 'deepseek-flash', question_count: 10 },
        usage: { inputTokens: 400, outputTokens: 3771 },
      }))),
    });

    expect(outcome).toEqual({ status: 'succeeded', runId: RUN_ID });
    expect(repository.succeeded).toEqual([
      {
        runId: RUN_ID,
        outputSummary: { assessment_id: 'a-1', model_id: 'deepseek-flash', question_count: 10 },
        inputTokens: 400,
        outputTokens: 3771,
        actualModelProfile: 'deepseek-flash',
      },
    ]);
  });

  it('摘要缺少 model_id 时 actual_model_profile 写 null', async () => {
    const repository = new FakeRepository();

    await executeAgentRun({
      task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
      retryCount: 0,
      repository,
      workflows: registryWith('assessment_generate', workflowOf(async () => ({
        outputSummary: { assessment_id: 'a-1' },
        usage: { inputTokens: 1, outputTokens: 2 },
      }))),
    });

    expect(repository.succeeded[0]?.actualModelProfile).toBeNull();
  });

  it('未注册的 run_type 归类为不可重试错误', async () => {
    const repository = new FakeRepository();

    await expect(
      executeAgentRun({
        task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
        retryCount: 0,
        repository,
        workflows: new AgentWorkflowRegistry(),
      }),
    ).rejects.toMatchObject({ code: AGENT_RUN_WORKFLOW_NOT_REGISTERED });
    expect(repository.succeeded).toHaveLength(0);
  });

  it('按可重试性归类 Provider 与内部接口错误', async () => {
    const cases: Array<{ error: Error; retryable: boolean }> = [
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_429', '限流', true), retryable: true },
      { error: new ModelGatewayError('MODEL_PROVIDER_RESPONSE_INVALID', '结构非法', false), retryable: false },
      { error: new CoreInternalClientError('CORE_INTERNAL_UNAVAILABLE', 'Web 不可用', true), retryable: true },
      { error: new CoreInternalClientError('AGENT_RUN_NOT_FOUND', '不存在', false), retryable: false },
      { error: new CredentialDecryptionError(CREDENTIAL_ENCRYPTION_UNAVAILABLE, '无密钥'), retryable: false },
    ];

    for (const testCase of cases) {
      const repository = new FakeRepository();
      const promise = executeAgentRun({
        task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
        retryCount: 0,
        repository,
        workflows: registryWith('assessment_generate', workflowOf(async () => {
          throw testCase.error;
        })),
      });

      if (testCase.retryable) {
        await expect(promise).rejects.toBeInstanceOf(RetryableAgentRunError);
      } else {
        await expect(promise).rejects.toBeInstanceOf(NonRetryableAgentRunError);
      }
    }
  });
});

describe('calculateRetryDelaySeconds', () => {
  it('按 10/20/40… 计算并封顶 300 秒', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((count) => calculateRetryDelaySeconds(count))).toEqual([
      10, 20, 40, 80, 160, 300, 300,
    ]);
  });
});

describe('handleAgentRunFailure', () => {
  it('可重试且未耗尽时记录下一次重试与延迟', async () => {
    const repository = new FakeRepository();

    const outcome = await handleAgentRunFailure({
      runId: RUN_ID,
      retryCount: 0,
      maxRetries: 3,
      error: new RetryableAgentRunError('MODEL_PROVIDER_HTTP_429', '限流'),
      repository,
    });

    expect(outcome).toEqual({ action: 'retry', delaySeconds: 10, retryCount: 1 });
    expect(repository.retried).toEqual([
      { runId: RUN_ID, retryCount: 1, delaySeconds: 10, errorCode: 'MODEL_PROVIDER_HTTP_429' },
    ]);
    expect(repository.failed).toHaveLength(0);
  });

  it('重试耗尽时写 AGENT_RUN_RETRY_EXHAUSTED', async () => {
    const repository = new FakeRepository();

    const outcome = await handleAgentRunFailure({
      runId: RUN_ID,
      retryCount: 3,
      maxRetries: 3,
      error: new RetryableAgentRunError('MODEL_PROVIDER_HTTP_500', 'provider 错误'),
      repository,
    });

    expect(outcome).toEqual({ action: 'failed', code: AGENT_RUN_RETRY_EXHAUSTED });
    expect(repository.failed).toEqual([
      { runId: RUN_ID, errorCode: AGENT_RUN_RETRY_EXHAUSTED, errorSummary: 'provider 错误' },
    ]);
    expect(repository.retried).toHaveLength(0);
  });

  it('不可重试错误直接写失败并透传错误码', async () => {
    const repository = new FakeRepository();

    const outcome = await handleAgentRunFailure({
      runId: RUN_ID,
      retryCount: 0,
      maxRetries: 3,
      error: new NonRetryableAgentRunError('AGENT_RUN_WORKFLOW_NOT_REGISTERED', '未注册'),
      repository,
    });

    expect(outcome).toEqual({ action: 'failed', code: AGENT_RUN_WORKFLOW_NOT_REGISTERED });
    expect(repository.failed[0]?.errorCode).toBe(AGENT_RUN_WORKFLOW_NOT_REGISTERED);
  });

  it('未识别异常归为 AGENT_RUN_UNEXPECTED_ERROR', async () => {
    const repository = new FakeRepository();

    const outcome = await handleAgentRunFailure({
      runId: RUN_ID,
      retryCount: 0,
      maxRetries: 3,
      error: new TypeError('boom'),
      repository,
    });

    expect(outcome).toEqual({ action: 'failed', code: AGENT_RUN_UNEXPECTED_ERROR });
    expect(repository.failed[0]?.errorSummary).toBe('boom');
  });
});
