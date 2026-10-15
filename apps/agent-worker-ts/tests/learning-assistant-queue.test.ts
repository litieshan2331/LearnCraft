/**
 * 学习助手队列第一阶段单元测试。
 *
 * 调用顺序：构造合法/非法 Job → 校验 BullMQ 载荷和 run_id 幂等发布 →
 * 模拟数据库领取 queued 运行 → 验证重复领取、归属不匹配和契约错误的处理结果。
 */

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adds: [] as Array<{ name: string; data: unknown; options: Record<string, unknown> }>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown, options: Record<string, unknown>) {
      mocks.adds.push({ name, data, options });
      return { id: String(options.jobId) };
    }
  },
  Worker: class {},
  UnrecoverableError: class extends Error {},
}));

import {
  LEARNING_ASSISTANT_JOB_NAME,
  publishLearningAssistantRun,
  toLearningAssistantJobPayload,
  type LearningAssistantRunTask,
} from '../src/infrastructure/queue/bullmq-agent-queue.js';
import {
  createLearningAssistantRunProcessor,
  LearningAssistantJobPayloadSchema,
} from '../src/interfaces/queue/learning-assistant-run-processor.js';
import {
  PgLearningAssistantRunQueueRepository,
  LearningAssistantRunContractError,
} from '../src/infrastructure/database/learning-assistant-run-queue-repository.js';

const TASK: LearningAssistantRunTask = {
  runId: '11111111-2222-4333-8444-555555555555',
  conversationId: '22222222-2222-4333-8444-555555555555',
  ownerId: '33333333-2222-4333-8444-555555555555',
  triggerMessageId: '44444444-2222-4333-8444-555555555555',
  connectionId: null,
  modelId: null,
  traceId: 'trace-learning-assistant',
  taskVersion: 1,
};

const CONFIG = {
  connection: { host: 'localhost', port: 6379, db: 0 },
  prefix: 'test:learning-assistant:',
  queueName: 'learning_assistant.run',
  concurrency: 1,
  lockDurationMs: 660_000,
  maxAttempts: 3,
  backoffMs: 10_000,
  backoffMaxMs: 300_000,
};

describe('学习助手 Job 载荷', () => {
  it('使用 run_id 作为 jobId 并保留服务端关联字段', async () => {
    mocks.adds.length = 0;
    const queue = { add: async (name: string, data: unknown, options: Record<string, unknown>) => {
      mocks.adds.push({ name, data, options });
      return { id: TASK.runId };
    } } as never;
    await publishLearningAssistantRun(queue, TASK, CONFIG);
    expect(mocks.adds[0]).toEqual({
      name: LEARNING_ASSISTANT_JOB_NAME,
      data: toLearningAssistantJobPayload(TASK),
      options: expect.objectContaining({ jobId: TASK.runId, attempts: 4 }),
    });
    expect(LearningAssistantJobPayloadSchema.parse(toLearningAssistantJobPayload(TASK))).toEqual(
      toLearningAssistantJobPayload(TASK),
    );
  });
});

describe('学习助手 Job 处理器', () => {
  it('领取成功后只返回，不在第一阶段执行 LangGraph', async () => {
    const beginExecution = vi.fn().mockResolvedValue({ runId: TASK.runId, status: 'running', shouldExecute: true });
    const processor = createLearningAssistantRunProcessor({ repository: { beginExecution } });
    await processor({ data: toLearningAssistantJobPayload(TASK) } as never);
    expect(beginExecution).toHaveBeenCalledWith(TASK);
  });

  it('重复领取已终态运行时不再次执行', async () => {
    const beginExecution = vi.fn().mockResolvedValue({ runId: TASK.runId, status: 'succeeded', shouldExecute: false });
    const processor = createLearningAssistantRunProcessor({ repository: { beginExecution } });
    await expect(processor({ data: toLearningAssistantJobPayload(TASK) } as never)).resolves.toBeUndefined();
  });

  it('重复领取 running 运行时允许从 Checkpoint 恢复执行', async () => {
    const beginExecution = vi.fn().mockResolvedValue({ runId: TASK.runId, status: 'running', shouldExecute: true });
    const processor = createLearningAssistantRunProcessor({ repository: { beginExecution } });
    await processor({ data: toLearningAssistantJobPayload(TASK) } as never);
    expect(beginExecution).toHaveBeenCalledWith(TASK);
  });

  it('拒绝修改过的载荷', async () => {
    const beginExecution = vi.fn();
    const processor = createLearningAssistantRunProcessor({ repository: { beginExecution } });
    await expect(processor({ data: { ...toLearningAssistantJobPayload(TASK), owner_id: 'not-uuid' } } as never)).rejects.toThrow();
    expect(beginExecution).not.toHaveBeenCalled();
  });
});

describe('学习助手 queued 运行领取', () => {
  it('将 queued 原子推进到 running，并在重复领取时返回 shouldExecute=false', async () => {
    const rows = [{
      id: TASK.runId,
      conversation_id: TASK.conversationId,
      owner_id: TASK.ownerId,
      trigger_message_id: TASK.triggerMessageId,
      status: 'queued',
      conversation_status: 'active',
    }];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT r.id')) return { rows };
        if (sql.includes("SET status = 'running'")) return { rows: [{ status: 'running' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new PgLearningAssistantRunQueueRepository({
      connect: async () => client,
    });
    await expect(repository.beginExecution(TASK)).resolves.toEqual({
      runId: TASK.runId,
      status: 'running',
      shouldExecute: true,
    });
    rows[0]!.status = 'running';
    await expect(repository.beginExecution(TASK)).resolves.toEqual({
      runId: TASK.runId,
      status: 'running',
      shouldExecute: true,
    });
    rows[0]!.status = 'succeeded';
    await expect(repository.beginExecution(TASK)).resolves.toEqual({
      runId: TASK.runId,
      status: 'succeeded',
      shouldExecute: false,
    });
  });

  it('载荷归属不一致时抛出不可重试契约错误', async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes('SELECT r.id')
        ? { rows: [{ ...TASK, conversation_id: 'different', status: 'queued', conversation_status: 'active' }] }
        : { rows: [] }),
      release: vi.fn(),
    };
    const repository = new PgLearningAssistantRunQueueRepository({ connect: async () => client });
    await expect(repository.beginExecution(TASK)).rejects.toBeInstanceOf(LearningAssistantRunContractError);
  });
});

