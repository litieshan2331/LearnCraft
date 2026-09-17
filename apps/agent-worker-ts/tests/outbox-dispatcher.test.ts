/**
 * Outbox Dispatcher 的单元测试（使用假连接池与假发布器）。
 *
 * 覆盖：领取 SQL 的 run_type 路由与 FOR UPDATE OF o、契约错误转 dead、投递失败按 10/20/40… 退避、
 * 重试耗尽转 dead，以及优雅关闭时释放已领取但未发布的事件。
 */
import { describe, expect, it } from 'vitest';

import type { AgentRunTask } from '../src/application/commands/execute-agent-run.js';
import type { OutboxDispatcherConfig } from '../src/bootstrap/config.js';
import type { PoolClientLike, PoolLike, QueryResultLike } from '../src/infrastructure/database/agent-run-repository.js';
import { OutboxDispatcher, type AgentRunPublisher } from '../src/infrastructure/queue/outbox-dispatcher.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

const CONFIG: OutboxDispatcherConfig = {
  connection: { host: 'localhost', port: 6380, db: 0 },
  queuePrefix: 'learncraft:agent-queue:',
  queueName: 'agent.run',
  eventType: 'agent.run.requested',
  databaseUrl: 'postgresql://unused',
  dispatcherId: 'dispatcher-under-test',
  pollIntervalSeconds: 1,
  batchSize: 20,
  lockTimeoutSeconds: 900,
  maxAttempts: 10,
  maxBackoffSeconds: 300,
  runTypes: ['assessment_generate'],
};

type Recorded = { text: string; values?: readonly unknown[] };

class FakeClient implements PoolClientLike {
  readonly queries: Recorded[] = [];

  constructor(private readonly claimed: Array<Record<string, unknown>>) {}

  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    this.queries.push({ text, values });
    if (text.includes('FOR UPDATE OF o')) {
      return { rows: this.claimed };
    }
    return { rows: [] };
  }

  release(): void {}

  find(fragment: string): Recorded | undefined {
    return this.queries.find((query) => query.text.includes(fragment));
  }
}

class FakePool implements PoolLike {
  constructor(readonly client: FakeClient) {}

  async connect(): Promise<PoolClientLike> {
    return this.client;
  }
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'event-1',
    aggregate_id: RUN_ID,
    event_version: 1,
    payload_json: { agent_run_id: RUN_ID, trace_id: 'trace-1', task_version: 1 },
    attempt_count: 1,
    ...overrides,
  };
}

class RecordingPublisher implements AgentRunPublisher {
  readonly published: AgentRunTask[] = [];

  constructor(
    private readonly behavior: 'ok' | 'fail' = 'ok',
    private readonly afterFirstPublish?: () => Promise<void>,
  ) {}

  async publish(task: AgentRunTask): Promise<void> {
    if (this.behavior === 'fail') {
      throw new Error('队列不可用');
    }
    this.published.push(task);
    if (this.published.length === 1 && this.afterFirstPublish !== undefined) {
      await this.afterFirstPublish();
    }
  }
}

function build(claimed: Array<Record<string, unknown>>, behavior: 'ok' | 'fail' = 'ok') {
  const client = new FakeClient(claimed);
  const publisher = new RecordingPublisher(behavior);
  const dispatcher = new OutboxDispatcher(new FakePool(client), publisher, CONFIG);
  return { dispatcher, client, publisher };
}

describe('领取 SQL', () => {
  it('带 run_type 路由过滤、JOIN agent_runs，并使用 FOR UPDATE OF o', async () => {
    const { dispatcher, client } = build([eventRow()]);

    await dispatcher.dispatchOnce();

    const claim = client.find('FOR UPDATE OF o');
    expect(claim).toBeDefined();
    expect(claim?.text).toContain('JOIN agent.agent_runs r ON r.id = o.aggregate_id');
    expect(claim?.text).toContain('r.run_type = ANY($2::text[])');
    // 关键：必须是 OF o，否则会连带锁住 agent_runs 并与 beginExecution 互相阻塞。
    expect(claim?.text).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(claim?.text).not.toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(claim?.values).toEqual(['agent.run.requested', ['assessment_generate'], 900, 20, 'dispatcher-under-test']);
  });

  it('回滚语义：路由集合为空时传入空数组，领取不到任何事件', async () => {
    const client = new FakeClient([]);
    const dispatcher = new OutboxDispatcher(
      new FakePool(client),
      new RecordingPublisher(),
      { ...CONFIG, runTypes: [] },
    );

    const claimed = await dispatcher.dispatchOnce();

    expect(claimed).toBe(0);
    expect(client.find('FOR UPDATE OF o')?.values?.[1]).toEqual([]);
  });
});

describe('投递与状态回写', () => {
  it('投递成功后回写 published', async () => {
    const { dispatcher, client, publisher } = build([eventRow()]);

    const claimed = await dispatcher.dispatchOnce();

    expect(claimed).toBe(1);
    expect(publisher.published).toEqual([{ agentRunId: RUN_ID, traceId: 'trace-1', taskVersion: 1 }]);
    expect(client.find("SET status = 'published'")?.values).toEqual(['event-1', 'dispatcher-under-test']);
  });

  it('事件版本不是 1 时转 dead 且不投递', async () => {
    const { dispatcher, client, publisher } = build([eventRow({ event_version: 2 })]);

    await dispatcher.dispatchOnce();

    expect(publisher.published).toHaveLength(0);
    expect(client.find("SET status = 'dead'")?.values?.[2]).toContain('不支持的 Outbox 事件版本');
  });

  it('聚合标识不一致时转 dead', async () => {
    const { dispatcher, client } = build([eventRow({ aggregate_id: 'other-aggregate' })]);

    await dispatcher.dispatchOnce();

    expect(client.find("SET status = 'dead'")?.values?.[2]).toContain('aggregate_id 与 agent_run_id 不一致');
  });

  it('载荷不符合契约时转 dead', async () => {
    const { dispatcher, client } = build([eventRow({ payload_json: { agent_run_id: 'not-a-uuid' } })]);

    await dispatcher.dispatchOnce();

    expect(client.find("SET status = 'dead'")?.values?.[2]).toContain('不符合契约');
  });

  it('投递失败时按 10/20/40… 退避回写 failed', async () => {
    const { dispatcher, client } = build([eventRow({ attempt_count: 3 })], 'fail');

    await dispatcher.dispatchOnce();

    const failed = client.find("SET status = 'failed'");
    expect(failed?.values?.[2]).toBe(40);
    expect(failed?.text).toContain("available_at = now() + ($3::int * interval '1 second')");
  });

  it('投递尝试耗尽时转 dead', async () => {
    const { dispatcher, client } = build([eventRow({ attempt_count: 10 })], 'fail');

    await dispatcher.dispatchOnce();

    expect(client.find("SET status = 'dead'")?.values?.[2]).toBe('投递重试耗尽');
    expect(client.find("SET status = 'failed'")).toBeUndefined();
  });
});

describe('优雅关闭', () => {
  it('批次内未发布的事件被立即释放，而不是等待锁租约', async () => {
    const client = new FakeClient([eventRow(), eventRow({ id: 'event-2' })]);
    let dispatcher: OutboxDispatcher;
    // 第一条发布完成后立刻触发关闭：第二条必须被释放而不是投递。
    const publisher = new RecordingPublisher('ok', async () => {
      await dispatcher.stop();
    });
    dispatcher = new OutboxDispatcher(new FakePool(client), publisher, CONFIG);

    const claimed = await dispatcher.dispatchOnce();

    expect(publisher.published).toHaveLength(1);
    const releases = client.queries.filter(
      (query) => query.text.includes("SET status = 'failed'") && query.values?.[2] === 0,
    );
    expect(releases).toHaveLength(1);
    expect(releases[0]?.values?.[3]).toContain('关闭时释放未投递事件');
    expect(claimed).toBe(1);
  });
});
