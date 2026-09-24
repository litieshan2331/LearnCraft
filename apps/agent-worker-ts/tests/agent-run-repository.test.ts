/**
 * AgentRun Repository 的等价性测试（用假连接池捕获 SQL 与参数）。
 *
 * 覆盖 Python 实现的关键不变量：FOR UPDATE 行锁、终态短路幂等、trace_id 校验、
 * 事件序号生成、retry_count 单调不减、错误字段截断，以及事务边界（BEGIN/COMMIT/ROLLBACK）。
 */
import { describe, expect, it } from 'vitest';

import { executeAgentRun } from '../src/application/commands/execute-agent-run.js';

import {
  AgentRunInvariantError,
  AgentRunNotFoundError,
  PgAgentRunRepository,
  type PoolClientLike,
  type PoolLike,
  type QueryResultLike,
} from '../src/infrastructure/database/agent-run-repository.js';

const RUN_ID = 'run-1';
const OWNER_ID = 'owner-1';
const TARGET_ID = 'goal-1';
const TRACE_ID = 'trace-1';

type Recorded = { text: string; values?: readonly unknown[] };

class FakeClient implements PoolClientLike {
  readonly queries: Recorded[] = [];
  released = false;

  constructor(
    private readonly responder: (text: string, values?: readonly unknown[]) => QueryResultLike | undefined,
  ) {}

  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    this.queries.push({ text, values });
    return this.responder(text, values) ?? { rows: [] };
  }

  release(): void {
    this.released = true;
  }

  find(fragment: string): Recorded | undefined {
    return this.queries.find((query) => query.text.includes(fragment));
  }

  count(fragment: string): number {
    return this.queries.filter((query) => query.text.includes(fragment)).length;
  }
}

class FakePool implements PoolLike {
  constructor(private readonly client: FakeClient) {}

  async connect(): Promise<PoolClientLike> {
    return this.client;
  }
}

/** 可观测连接池：记录当前持有的数据库连接数量，供生命周期回归测试使用。 */
class TrackingPool implements PoolLike {
  activeConnections = 0;
  maxActiveConnections = 0;

  /** 获取一个会在 release 时归还计数的跟踪连接。 */
  async connect(): Promise<PoolClientLike> {
    this.activeConnections += 1;
    this.maxActiveConnections = Math.max(this.maxActiveConnections, this.activeConnections);
    return new TrackingClient(this);
  }

  /** 在连接释放时减少当前活动连接计数。 */
  releaseConnection(): void {
    this.activeConnections -= 1;
  }
}

/** 跟踪连接池中的单个连接，并返回 AgentRun 仓储所需的最小查询结果。 */
class TrackingClient implements PoolClientLike {
  private released = false;

  constructor(private readonly pool: TrackingPool) {}

  /** 响应仓储测试所需的行锁、取消状态与事件序号查询。 */
  async query(text: string): Promise<QueryResultLike> {
    if (text.includes('FOR UPDATE')) {
      return { rows: [runRow()] };
    }
    if (text.includes('SELECT status FROM agent.agent_runs')) {
      return { rows: [{ status: 'running' }] };
    }
    if (text.includes('MAX(sequence_no)')) {
      return { rows: [{ last_sequence_no: 0 }] };
    }
    return { rows: [] };
  }

  /** 只允许连接释放一次，避免测试计数出现负数。 */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.pool.releaseConnection();
  }
}

/** 创建可手动放行的异步闸门，用于模拟模型请求持续等待。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    owner_id: OWNER_ID,
    run_type: 'assessment_generate',
    target_type: 'learning_goal',
    target_id: TARGET_ID,
    input_summary_json: { topic: 'TypeScript' },
    status: 'queued',
    retry_count: 0,
    trace_id: TRACE_ID,
    ...overrides,
  };
}

function buildRepository(options: {
  row?: Record<string, unknown> | null;
  cancelStatus?: string;
  lastSequenceNo?: number;
} = {}): { repository: PgAgentRunRepository; client: FakeClient } {
  const row = options.row === undefined ? runRow() : options.row;
  const client = new FakeClient((text) => {
    if (text.includes('FOR UPDATE')) {
      return { rows: row === null ? [] : [row] };
    }
    if (text.includes('SELECT status FROM agent.agent_runs')) {
      return { rows: [{ status: options.cancelStatus ?? 'running' }] };
    }
    if (text.includes('MAX(sequence_no)')) {
      return { rows: [{ last_sequence_no: options.lastSequenceNo ?? 3 }] };
    }
    return { rows: [] };
  });
  return { repository: new PgAgentRunRepository(new FakePool(client)), client };
}

describe('PgAgentRunRepository.markFailed', () => {
  it('card_content_generate 最终失败时把节点内容状态置回 failed（同一事务）', async () => {
    const { repository, client } = buildRepository({
      row: runRow({
        run_type: 'card_content_generate',
        target_type: 'plan_node',
        target_id: 'node-1',
        status: 'running',
      }),
    });

    await repository.markFailed({
      runId: RUN_ID,
      errorCode: 'CARD_CONTENT_OUTPUT_INVALID',
      errorSummary: '模型输出不符合 card_content.v2',
    });

    const update = client.find('UPDATE public.plan_nodes');
    expect(update?.values).toEqual(['node-1']);
    expect(client.count('UPDATE public.plan_nodes')).toBe(1);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
  });

  it('其它类型的失败不改动节点内容状态', async () => {
    const { repository, client } = buildRepository({
      row: runRow({ run_type: 'plan_generate', status: 'running' }),
    });

    await repository.markFailed({
      runId: RUN_ID,
      errorCode: 'MODEL_TIMEOUT',
      errorSummary: '模型超时',
    });

    expect(client.count('UPDATE public.plan_nodes')).toBe(0);
  });

  it('终态运行的重复投递不再写节点状态', async () => {
    const { repository, client } = buildRepository({
      row: runRow({
        run_type: 'card_content_generate',
        target_type: 'plan_node',
        status: 'failed',
      }),
    });

    await repository.markFailed({
      runId: RUN_ID,
      errorCode: 'CARD_CONTENT_OUTPUT_INVALID',
      errorSummary: '重复投递',
    });

    expect(client.count('UPDATE public.plan_nodes')).toBe(0);
  });
});

describe('AgentRun 执行连接生命周期', () => {
  it('模型等待期间不持有 PostgreSQL 连接', async () => {
    const pool = new TrackingPool();
    const repository = new PgAgentRunRepository(pool);
    const modelGate = deferred();
    const workflowStarted = deferred();

    const execution = executeAgentRun({
      task: { agentRunId: RUN_ID, traceId: TRACE_ID, taskVersion: 1 },
      retryCount: 0,
      repository,
      workflows: {
        resolve: () => ({
          run: async () => {
            workflowStarted.resolve();
            await modelGate.promise;
            return {
              outputSummary: { model_id: 'test-model' },
              usage: { inputTokens: 3, outputTokens: 5 },
            };
          },
        }),
      },
    });

    await workflowStarted.promise;
    expect(pool.activeConnections).toBe(0);

    modelGate.resolve();
    await expect(execution).resolves.toEqual({ status: 'succeeded', runId: RUN_ID });
    expect(pool.activeConnections).toBe(0);
    expect(pool.maxActiveConnections).toBeGreaterThan(0);
  });

  it('以行锁领取 queued 运行并追加 run.started', async () => {
    const { repository, client } = buildRepository({ lastSequenceNo: 3 });

    const state = await repository.beginExecution({ runId: RUN_ID, traceId: TRACE_ID, retryCount: 1 });

    expect(state).toMatchObject({ runId: RUN_ID, ownerId: OWNER_ID, status: 'running', shouldExecute: true });
    expect(state.inputSummaryJson).toEqual({ topic: 'TypeScript' });

    const select = client.find('FOR UPDATE');
    expect(select?.text).toContain('FROM agent.agent_runs');
    expect(select?.values).toEqual([RUN_ID]);

    const update = client.find("SET status = 'running'");
    expect(update?.text).toContain('started_at = COALESCE(started_at, now())');
    expect(update?.values).toEqual([RUN_ID, 1]);

    const event = client.find('INSERT INTO agent.agent_run_events');
    expect(event?.values).toEqual([RUN_ID, 4, 'run.started', JSON.stringify({ retry_count: 1 })]);

    expect(client.queries[0]?.text).toBe('BEGIN');
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
    expect(client.released).toBe(true);
  });

  it('终态运行时短路且不写任何事件（重复投递幂等）', async () => {
    const { repository, client } = buildRepository({ row: runRow({ status: 'succeeded' }) });

    const state = await repository.beginExecution({ runId: RUN_ID, traceId: TRACE_ID, retryCount: 0 });

    expect(state.shouldExecute).toBe(false);
    expect(state.status).toBe('succeeded');
    expect(client.count('UPDATE agent.agent_runs')).toBe(0);
    expect(client.count('INSERT INTO agent.agent_run_events')).toBe(0);
  });

  it('已处于 running 时追加 run.resumed 而不改写状态', async () => {
    const { repository, client } = buildRepository({ row: runRow({ status: 'running', retry_count: 2 }) });

    const state = await repository.beginExecution({ runId: RUN_ID, traceId: TRACE_ID, retryCount: 0 });

    expect(state.shouldExecute).toBe(true);
    expect(client.count("SET status = 'running'")).toBe(0);
    expect(client.find('INSERT INTO agent.agent_run_events')?.values?.[2]).toBe('run.resumed');
    // retry_count 单调不减：既有 2 大于传入 0。
    expect(client.find('UPDATE agent.agent_runs SET retry_count')?.values).toEqual([RUN_ID, 2]);
  });

  it('trace_id 不匹配时回滚且不写入', async () => {
    const { repository, client } = buildRepository();

    await expect(
      repository.beginExecution({ runId: RUN_ID, traceId: 'other-trace', retryCount: 0 }),
    ).rejects.toBeInstanceOf(AgentRunInvariantError);

    expect(client.count('UPDATE agent.agent_runs')).toBe(0);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });

  it('运行不存在时报 AgentRunNotFoundError 并回滚', async () => {
    const { repository, client } = buildRepository({ row: null });

    await expect(
      repository.beginExecution({ runId: RUN_ID, traceId: TRACE_ID, retryCount: 0 }),
    ).rejects.toBeInstanceOf(AgentRunNotFoundError);

    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });

  it('遇到不支持的状态时直接报错', async () => {
    const { repository } = buildRepository({ row: runRow({ status: 'paused' }) });

    await expect(
      repository.beginExecution({ runId: RUN_ID, traceId: TRACE_ID, retryCount: 0 }),
    ).rejects.toBeInstanceOf(AgentRunInvariantError);
  });
});

describe('PgAgentRunRepository 终态写入', () => {
  it('markSucceeded 写入摘要与 token 并追加事件，负数被夹到 0', async () => {
    const { repository, client } = buildRepository({ lastSequenceNo: 1 });

    await repository.markSucceeded({
      runId: RUN_ID,
      outputSummary: { assessment_id: 'a-1', question_count: 12 },
      inputTokens: -5,
      outputTokens: 30,
      actualModelProfile: 'account_default_openai_compatible',
    });

    const update = client.find("SET status = 'succeeded'");
    expect(update?.values).toEqual([
      RUN_ID,
      JSON.stringify({ assessment_id: 'a-1', question_count: 12 }),
      0,
      30,
      'account_default_openai_compatible',
    ]);
    expect(client.find('INSERT INTO agent.agent_run_events')?.values).toEqual([
      RUN_ID,
      2,
      'run.succeeded',
      JSON.stringify({ input_tokens: 0, output_tokens: 30 }),
    ]);
  });

  it('markSucceeded 在终态运行上短路', async () => {
    const { repository, client } = buildRepository({ row: runRow({ status: 'failed' }) });

    await repository.markSucceeded({ runId: RUN_ID, outputSummary: {} });

    expect(client.count("SET status = 'succeeded'")).toBe(0);
    expect(client.count('INSERT INTO agent.agent_run_events')).toBe(0);
  });

  it('markRetryScheduled 把运行重置为 queued 并记录延迟', async () => {
    const { repository, client } = buildRepository({ row: runRow({ status: 'running', retry_count: 1 }) });

    await repository.markRetryScheduled({
      runId: RUN_ID,
      retryCount: 2,
      delaySeconds: 20,
      errorCode: 'MODEL_PROVIDER_HTTP_429',
    });

    expect(client.find("SET status = 'queued'")?.values).toEqual([RUN_ID, 2, 'MODEL_PROVIDER_HTTP_429']);
    expect(client.find('INSERT INTO agent.agent_run_events')?.values?.[3]).toBe(
      JSON.stringify({ retry_count: 2, delay_seconds: 20, error_code: 'MODEL_PROVIDER_HTTP_429' }),
    );
  });

  it('markFailed 按 100/1000 字符截断错误字段', async () => {
    const { repository, client } = buildRepository();

    await repository.markFailed({
      runId: RUN_ID,
      errorCode: 'E'.repeat(150),
      errorSummary: 'S'.repeat(2_000),
    });

    const update = client.find("SET status = 'failed'");
    expect((update?.values?.[1] as string).length).toBe(100);
    expect((update?.values?.[2] as string).length).toBe(1_000);
  });
});

describe('PgAgentRunRepository.isCancelled', () => {
  it('仅在状态为 cancelled 时返回 true', async () => {
    const cancelled = buildRepository({ cancelStatus: 'cancelled' });
    await expect(cancelled.repository.isCancelled(RUN_ID)).resolves.toBe(true);

    const running = buildRepository({ cancelStatus: 'running' });
    await expect(running.repository.isCancelled(RUN_ID)).resolves.toBe(false);
  });
});