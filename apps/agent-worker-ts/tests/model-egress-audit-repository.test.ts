/**
 * 出网审计写入器的单元测试（假连接池）。
 *
 * 覆盖：同一事务内先清理过期行再插入；只写入七个安全字段；expires_at 由保留天数计算；
 * 失败时回滚；以及把该错误交给 SafeModelEgressClient 时表现为 fail-closed。
 */
import { describe, expect, it } from 'vitest';

import type { PoolClientLike, PoolLike, QueryResultLike } from '../src/infrastructure/database/agent-run-repository.js';
import { PgModelEgressAuditRepository } from '../src/infrastructure/database/model-egress-audit-repository.js';
import {
  MODEL_EGRESS_AUDIT_UNAVAILABLE,
  SafeModelEgressClient,
  type ModelEgressAuditEntry,
} from '../src/infrastructure/llm/safe-egress-client.js';
import type { EgressEndpointPolicy } from '../src/infrastructure/llm/egress-policy.js';

type Recorded = { text: string; values?: readonly unknown[] };

class FakeClient implements PoolClientLike {
  readonly queries: Recorded[] = [];

  constructor(private readonly failOn?: string) {}

  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    this.queries.push({ text, values });
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      throw new Error('数据库不可用');
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

const ENTRY: ModelEgressAuditEntry = {
  ownerId: '11111111-2222-4333-8444-555555555555',
  modelConnectionId: '66666666-7777-4888-8999-000000000000',
  agentRunId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
  host: 'api.example.com',
  port: 443,
  decision: 'allowed',
  reasonCode: 'MODEL_EGRESS_POLICY_ALLOWED',
};

describe('PgModelEgressAuditRepository', () => {
  it('在同一事务内先清理过期行再插入审计行', async () => {
    const client = new FakeClient();
    const repository = new PgModelEgressAuditRepository(new FakePool(client), 30);

    await repository.record(ENTRY);

    expect(client.queries.map((query) => query.text.split('\n')[0]?.trim())).toEqual([
      'BEGIN',
      'DELETE FROM public.model_connection_egress_audits WHERE expires_at <= now()',
      'INSERT INTO public.model_connection_egress_audits',
      'COMMIT',
    ]);
    expect(client.find('INSERT INTO public.model_connection_egress_audits')?.values).toEqual([
      ENTRY.ownerId,
      ENTRY.modelConnectionId,
      ENTRY.agentRunId,
      'api.example.com',
      443,
      'allowed',
      'MODEL_EGRESS_POLICY_ALLOWED',
      30,
    ]);
    // 只写安全字段：SQL 中不得出现任何密钥、Prompt 或正文列。
    const insert = client.find('INSERT INTO public.model_connection_egress_audits')?.text ?? '';
    expect(insert).not.toMatch(/api_key|prompt|payload|body/i);
  });

  it('写入失败时回滚并向上抛出', async () => {
    const client = new FakeClient('INSERT INTO public.model_connection_egress_audits');
    const repository = new PgModelEgressAuditRepository(new FakePool(client), 30);

    await expect(repository.record(ENTRY)).rejects.toThrow('数据库不可用');
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });

  it('审计不可用时出网被拒绝（fail-closed）', async () => {
    const client = new FakeClient('INSERT INTO public.model_connection_egress_audits');
    const repository = new PgModelEgressAuditRepository(new FakePool(client), 30);
    const policy: EgressEndpointPolicy = {
      resolveEndpoint: async () => ({
        baseUrl: 'https://api.example.com',
        hostname: 'api.example.com',
        port: 443,
        pinnedIp: '8.8.8.8',
      }),
    };
    const requester = {
      request: async () => {
        throw new Error('不应发起请求');
      },
    };
    const egress = new SafeModelEgressClient(
      { enabled: true, proxyUrl: null, connectTimeoutMs: 1_000, readTimeoutMs: 1_000, maxResponseBytes: 1_024 },
      repository,
      policy,
      requester,
    );

    await expect(
      egress.postOpenAiCompatibleJson({
        ownerId: ENTRY.ownerId,
        modelConnectionId: ENTRY.modelConnectionId,
        agentRunId: ENTRY.agentRunId,
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        endpointSegments: ['chat', 'completions'],
        payload: {},
      }),
    ).rejects.toMatchObject({ code: MODEL_EGRESS_AUDIT_UNAVAILABLE, retryable: true });
  });
});
