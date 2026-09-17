/**
 * BullMQ 队列装配的单元测试（mock bullmq，不连接真实 Redis）。
 *
 * 覆盖：队列名与前缀隔离、jobId 去重、attempts 与自定义退避、锁时长，以及退避数值序列。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueAdds: [] as Array<{ name: string; data: unknown; options: Record<string, unknown> }>,
  queueOptions: [] as unknown[],
  workerOptions: [] as unknown[],
}));

vi.mock('bullmq', () => {
  class Queue {
    readonly name: string;
    readonly options: unknown;

    constructor(name: string, options: unknown) {
      this.name = name;
      this.options = options;
      mocks.queueOptions.push(options);
    }

    async add(name: string, data: unknown, options: Record<string, unknown>): Promise<{ id: string }> {
      mocks.queueAdds.push({ name, data, options });
      return { id: 'job-1' };
    }

    async close(): Promise<void> {}
  }

  class Worker {
    readonly name: string;
    readonly processor: unknown;
    readonly options: unknown;

    constructor(name: string, processor: unknown, options: unknown) {
      this.name = name;
      this.processor = processor;
      this.options = options;
      mocks.workerOptions.push(options);
    }

    async close(): Promise<void> {}
  }

  class UnrecoverableError extends Error {}

  return { Queue, Worker, UnrecoverableError };
});

import type { AgentQueueConfig } from '../src/bootstrap/config.js';
import {
  AGENT_RUN_JOB_NAME,
  agentJobBackoffDelayMs,
  createAgentQueue,
  createAgentRunWorker,
  publishAgentRun,
} from '../src/infrastructure/queue/bullmq-agent-queue.js';

const CONFIG: AgentQueueConfig = {
  connection: { host: '127.0.0.1', port: 6380, db: 0 },
  prefix: 'learncraft:agent-queue:',
  queueName: 'agent.run',
  concurrency: 4,
  lockDurationMs: 660_000,
  maxAttempts: 3,
  backoffMs: 10_000,
  backoffMaxMs: 300_000,
};

beforeEach(() => {
  mocks.queueAdds.length = 0;
  mocks.queueOptions.length = 0;
  mocks.workerOptions.length = 0;
});

describe('队列装配', () => {
  it('使用显式前缀与队列名创建队列', () => {
    createAgentQueue(CONFIG);
    expect(mocks.queueOptions[0]).toEqual({
      connection: CONFIG.connection,
      prefix: 'learncraft:agent-queue:',
    });
  });

  it('发布时使用 agent_run_id 作为 jobId，并带重试与退避选项', async () => {
    const queue = createAgentQueue(CONFIG);
    await publishAgentRun(queue, { agentRunId: 'run-1', traceId: 'trace-1', taskVersion: 1 }, CONFIG);

    expect(mocks.queueAdds[0]?.name).toBe(AGENT_RUN_JOB_NAME);
    expect(mocks.queueAdds[0]?.data).toEqual({ agent_run_id: 'run-1', trace_id: 'trace-1', task_version: 1 });
    expect(mocks.queueAdds[0]?.options).toMatchObject({
      jobId: 'run-1',
      attempts: 4,
      backoff: { type: 'custom' },
    });
  });

  it('消费端把并发、锁时长与自定义退避交给 BullMQ', () => {
    createAgentRunWorker(CONFIG, async () => undefined);

    const options = mocks.workerOptions[0] as {
      concurrency: number;
      lockDuration: number;
      prefix: string;
      settings: { backoffStrategy: (attemptsMade: number) => number };
    };
    expect(options.concurrency).toBe(4);
    expect(options.lockDuration).toBe(660_000);
    expect(options.prefix).toBe('learncraft:agent-queue:');
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => options.settings.backoffStrategy(n))).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });
});

describe('agentJobBackoffDelayMs', () => {
  it('与数据库记录的退避使用同一公式并封顶', () => {
    expect([1, 2, 3, 6].map((n) => agentJobBackoffDelayMs(n, CONFIG))).toEqual([10_000, 20_000, 40_000, 300_000]);
  });
});
