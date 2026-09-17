/**
 * BullMQ 消费适配器的单元测试。
 *
 * 覆盖：成功执行、可重试错误让 BullMQ 重投、重试耗尽与不可重试错误转 UnrecoverableError，
 * 以及非法载荷不写任何运行状态。
 */
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { AgentRunRepositoryPort } from '../src/application/commands/execute-agent-run.js';
import { AGENT_RUN_RETRY_EXHAUSTED, AGENT_RUN_WORKFLOW_NOT_REGISTERED } from '../src/application/commands/execute-agent-run.js';
import { AgentWorkflowRegistry } from '../src/application/services/agent-workflow-registry.js';
import type { AgentRunExecutionState } from '../src/infrastructure/database/agent-run-repository.js';
import type { AgentRunJobPayload } from '../src/infrastructure/queue/bullmq-agent-queue.js';
import { createAgentRunProcessor } from '../src/interfaces/queue/agent-run-processor.js';
import { ModelGatewayError } from '../src/infrastructure/llm/model-gateway.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

class FakeRepository implements AgentRunRepositoryPort {
  readonly succeeded: Array<Record<string, unknown>> = [];
  readonly failed: Array<Record<string, unknown>> = [];
  readonly retried: Array<Record<string, unknown>> = [];

  async beginExecution(): Promise<AgentRunExecutionState> {
    return {
      runId: RUN_ID,
      ownerId: 'owner-1',
      runType: 'assessment_generate',
      targetType: 'learning_goal',
      targetId: 'goal-1',
      inputSummaryJson: {},
      status: 'running',
      shouldExecute: true,
    };
  }

  async isCancelled(): Promise<boolean> {
    return false;
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

function job(data: unknown, attemptsMade: number): Job<AgentRunJobPayload> {
  return { data, attemptsMade } as unknown as Job<AgentRunJobPayload>;
}

const VALID_PAYLOAD = { agent_run_id: RUN_ID, trace_id: 'trace-1', task_version: 1 };

function build(options: { runType?: string; workflowError?: Error; maxRetries?: number } = {}) {
  const repository = new FakeRepository();
  const workflows = new AgentWorkflowRegistry();
  if (options.runType !== undefined) {
    workflows.register(options.runType, {
      run: async () => {
        if (options.workflowError !== undefined) {
          throw options.workflowError;
        }
        return {
          outputSummary: { assessment_id: 'a-1', model_id: 'deepseek-flash' },
          usage: { inputTokens: 400, outputTokens: 4286 },
        };
      },
    });
  }
  const processor = createAgentRunProcessor({
    repository,
    workflows,
    maxRetries: options.maxRetries ?? 3,
  });
  return { processor, repository };
}

describe('createAgentRunProcessor', () => {
  it('成功执行后写出真实 token 用量，且不抛错', async () => {
    const { processor, repository } = build({ runType: 'assessment_generate' });

    await expect(processor(job(VALID_PAYLOAD, 0))).resolves.toBeUndefined();

    expect(repository.succeeded[0]).toMatchObject({ inputTokens: 400, outputTokens: 4286 });
    expect(repository.failed).toHaveLength(0);
  });

  it('可重试错误在未耗尽时抛出普通错误，让 BullMQ 按退避重投', async () => {
    const { processor, repository } = build({
      runType: 'assessment_generate',
      workflowError: new ModelGatewayError('MODEL_PROVIDER_HTTP_429', '限流', true),
    });

    await expect(processor(job(VALID_PAYLOAD, 0))).rejects.toThrow('限流');

    expect(repository.retried).toEqual([
      { runId: RUN_ID, retryCount: 1, delaySeconds: 10, errorCode: 'MODEL_PROVIDER_HTTP_429' },
    ]);
    expect(repository.failed).toHaveLength(0);
  });

  it('重试耗尽时写 AGENT_RUN_RETRY_EXHAUSTED 并抛 UnrecoverableError', async () => {
    const { processor, repository } = build({
      runType: 'assessment_generate',
      workflowError: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', 'provider 错误', true),
    });

    const error = await processor(job(VALID_PAYLOAD, 3)).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(String((error as Error).message)).toContain(AGENT_RUN_RETRY_EXHAUSTED);
    expect(repository.failed[0]?.errorCode).toBe(AGENT_RUN_RETRY_EXHAUSTED);
    expect(repository.retried).toHaveLength(0);
  });

  it('未注册的 run_type 直接失败且不重投', async () => {
    const { processor, repository } = build();

    const error = await processor(job(VALID_PAYLOAD, 0)).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(repository.failed[0]?.errorCode).toBe(AGENT_RUN_WORKFLOW_NOT_REGISTERED);
  });

  it('非法载荷抛 UnrecoverableError 且不写任何运行状态', async () => {
    const { processor, repository } = build({ runType: 'assessment_generate' });

    const error = await processor(job({ agent_run_id: 'not-a-uuid' }, 0)).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(repository.succeeded).toHaveLength(0);
    expect(repository.failed).toHaveLength(0);
    expect(repository.retried).toHaveLength(0);
  });
});
