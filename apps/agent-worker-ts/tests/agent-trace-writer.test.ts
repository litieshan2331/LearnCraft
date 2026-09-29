/** PgTraceWriter 的观测写入测试：覆盖序号、JSONB 载荷、Token 归一化和事务回滚。 */
import { describe, expect, it } from 'vitest';

import {
  PgTraceWriter,
  type TracePool,
  type TracePoolClient,
} from '../src/infrastructure/database/agent-trace-writer.js';

type Query = { text: string; values?: readonly unknown[] };

class FakeClient implements TracePoolClient {
  readonly queries: Query[] = [];
  released = false;

  constructor(private readonly failInsert = false) {}

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push({ text, values });
    if (text.includes('INSERT INTO') && this.failInsert) {
      throw new Error('insert failed');
    }
    if (text.includes('SELECT id FROM agent.agent_runs')) return { rows: [{ id: 'run-1' }] };
    if (text.includes('MAX(sequence_no)')) return { rows: [{ last_sequence_no: 4 }] };
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements TracePool {
  constructor(readonly client: FakeClient) {}

  async connect(): Promise<TracePoolClient> {
    return this.client;
  }
}

describe('PgTraceWriter', () => {
  it('在 AgentRun 行锁内写入连续序号与完整 JSONB 载荷', async () => {
    const client = new FakeClient();
    const writer = new PgTraceWriter(new FakePool(client));

    await writer.append({
      runId: 'run-1',
      eventType: 'llm.attempt.completed',
      turnNo: 2,
      attemptNo: 2,
      inputTokens: -1,
      outputTokens: 7,
      payload: { thinking: null, output: '完成' },
    });

    const insert = client.queries.find((query) => query.text.includes('INSERT INTO'));
    expect(insert?.values).toEqual([
      'run-1', 5, 'llm.attempt.completed', 2, null, 2, null, null, 0, 7,
      JSON.stringify({ thinking: null, output: '完成' }),
    ]);
    expect(client.queries[0]?.text).toBe('BEGIN');
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
    expect(client.released).toBe(true);
  });

  it('插入失败时回滚并释放连接', async () => {
    const client = new FakeClient(true);
    const writer = new PgTraceWriter(new FakePool(client));

    await expect(writer.append({
      runId: 'run-1',
      eventType: 'run.started',
      payload: {},
    })).rejects.toThrow('insert failed');
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
    expect(client.released).toBe(true);
  });
});
