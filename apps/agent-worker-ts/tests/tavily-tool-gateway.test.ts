/**
 * Tavily 工具网关的单元测试（不发起真实网络请求）。
 *
 * 重点固化与 Python 一致的顺序与错误码：工具名白名单 → API Key 检查 → 每日配额 → query 校验 →
 * MCP 调用（最多两次尝试）→ 网络类错误归类；以及搜索结果与提取结果的字段收敛规则。
 * MCP 传输本身的真实往返由 live 用例覆盖，这里通过注入 fetch 验证失败归类与重试次数。
 */
import { describe, expect, it } from 'vitest';

import {
  TAVILY_SEARCH_TOOL,
  TavilyMcpError,
  TavilyToolGateway,
  isNetworkError,
  parseExtractedSources,
  parseSearchSources,
  readMcpPayload,
  type DailyQuotaCounter,
  type TavilyToolSettings,
} from '../src/infrastructure/mcp/tavily-tool-gateway.js';
import type { ToolCircuitBreaker, ToolCircuitLease } from '../src/infrastructure/redis/tool-circuit-breaker.js';

const SETTINGS: TavilyToolSettings = {
  apiKey: 'tvly-test-key',
  ownerId: '11111111-2222-4333-8444-555555555555',
  dailyLimit: 3,
  quotaKeyPrefix: 'ratelimit:tavily:daily:',
  searchMaxResults: 5,
  extractTopResults: 2,
  extractChunksPerSource: 3,
  proxyUrl: null,
};

class FakeQuota implements DailyQuotaCounter {
  readonly keys: string[] = [];
  decremented = 0;

  constructor(private count: number | null) {}

  async increment(key: string): Promise<number | null> {
    this.keys.push(key);
    if (this.count === null) {
      return null;
    }
    this.count += 1;
    return this.count;
  }

  async decrement(): Promise<void> {
    this.decremented += 1;
  }
}

function gateway(options: {
  settings?: Partial<TavilyToolSettings>;
  quota?: DailyQuotaCounter;
  fetchImpl?: unknown;
  circuitBreaker?: ToolCircuitBreaker;
} = {}) {
  const quota = options.quota ?? new FakeQuota(0);
  return new TavilyToolGateway({
    settings: { ...SETTINGS, ...options.settings },
    quota,
    circuitBreaker: options.circuitBreaker,
    fetchImpl: (options.fetchImpl ?? (async () => {
      throw new Error('单元测试不应发起真实网络请求');
    })) as never,
  });
}

const SEARCH_CALL = { id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"TypeScript"}' };


class FakeCircuitBreaker implements ToolCircuitBreaker {
  acquireCalls = 0;
  successCalls = 0;
  failureCalls = 0;
  lease: ToolCircuitLease | null = { probe: false };

  async acquire(): Promise<ToolCircuitLease | null> {
    this.acquireCalls += 1;
    return this.lease;
  }

  async recordSuccess(): Promise<void> {
    this.successCalls += 1;
  }

  async recordFailure(): Promise<void> {
    this.failureCalls += 1;
  }
}


describe('执行前的校验与配额', () => {
  it('只接受 tavily_search', async () => {
    const result = await gateway().execute({ ...SEARCH_CALL, name: 'tavily_extract' });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED', data: {} });
  });

  it('未配置 API Key 时返回受控错误', async () => {
    const result = await gateway({ settings: { apiKey: null } }).execute(SEARCH_CALL);
    expect(result).toMatchObject({ ok: false, code: 'TAVILY_API_KEY_MISSING' });
  });

  it('配额 Redis 不可用时拒绝联网（不绕过配额）', async () => {
    const result = await gateway({ quota: new FakeQuota(null) }).execute(SEARCH_CALL);
    expect(result).toMatchObject({ ok: false, code: 'TAVILY_QUOTA_UNAVAILABLE' });
  });

  it('超过每日额度时回滚计数并拒绝', async () => {
    const quota = new FakeQuota(SETTINGS.dailyLimit);
    const result = await gateway({ quota }).execute(SEARCH_CALL);

    expect(result).toMatchObject({ ok: false, code: 'TAVILY_DAILY_QUOTA_EXCEEDED' });
    expect(quota.decremented).toBe(1);
  });

  it('配额键按账户与 UTC 日期生成', async () => {
    const quota = new FakeQuota(0);
    await gateway({ quota }).execute(SEARCH_CALL);

    const day = new Date().toISOString().slice(0, 10);
    expect(quota.keys[0]).toBe(SETTINGS.quotaKeyPrefix + SETTINGS.ownerId + ':' + day);
  });

  it('query 非法时返回 TAVILY_QUERY_INVALID', async () => {
    const cases = ['不是 JSON', '[]', '{}', '{"query":""}', '{"query":123}', '{"query":"' + 'x'.repeat(501) + '"}'];
    for (const argumentsJson of cases) {
      const result = await gateway().execute({ ...SEARCH_CALL, argumentsJson });
      expect(result.code).toBe('TAVILY_QUERY_INVALID');
    }
  });
});

describe('工具熔断接入', () => {
  it('工具成功后记录熔断成功', async () => {
    const circuit = new FakeCircuitBreaker();
    const result = await gateway({
      circuitBreaker: circuit,
      fetchImpl: async () => {
        throw new Error('普通错误');
      },
    }).execute(SEARCH_CALL);
    expect(result.code).toBe('TAVILY_MCP_CALL_FAILED');
    expect(circuit.acquireCalls).toBe(1);
    expect(circuit.failureCalls).toBe(1);
  });

  it('熔断打开时返回 TOOL_UNAVAILABLE，不调用外部工具', async () => {
    const circuit = new FakeCircuitBreaker();
    circuit.lease = null;
    const result = await gateway({ circuitBreaker: circuit }).execute(SEARCH_CALL);
    expect(result).toMatchObject({ ok: false, code: 'TOOL_UNAVAILABLE' });
    expect(circuit.acquireCalls).toBe(1);
  });
});

describe('MCP 调用失败归类', () => {
  it('网络类错误归类为 TAVILY_MCP_UNAVAILABLE，并最多尝试两次', async () => {
    let calls = 0;
    const failingFetch = async () => {
      calls += 1;
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = Object.assign(new Error('connect timeout'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      });
      throw error;
    };

    const result = await gateway({ fetchImpl: failingFetch }).execute(SEARCH_CALL);

    expect(result).toMatchObject({ ok: false, code: 'TAVILY_MCP_UNAVAILABLE' });
    expect(calls).toBe(2);
  }, 10_000);

  it('isNetworkError 识别 undici 与系统错误码，忽略普通错误', () => {
    expect(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    expect(isNetworkError(new Error('普通错误'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe('MCP 结果解析', () => {
  it('优先使用 structuredContent，其次解析 content 文本', () => {
    expect(readMcpPayload({ structuredContent: { results: [] } }, 'CODE')).toEqual({ results: [] });
    expect(
      readMcpPayload({ content: [{ type: 'text', text: '{"results":[]}' }] }, 'CODE'),
    ).toEqual({ results: [] });
  });

  it('工具错误或无法解析时抛出带稳定错误码的异常', () => {
    expect(() => readMcpPayload({ isError: true }, 'TAVILY_SEARCH_FAILED')).toThrow(TavilyMcpError);
    try {
      readMcpPayload({ content: [{ type: 'text', text: '不是 JSON' }] }, 'TAVILY_SEARCH_FAILED');
    } catch (error) {
      expect((error as TavilyMcpError).code).toBe('TAVILY_SEARCH_FAILED');
    }
  });

  it('搜索结果只保留 http(s) 来源并裁剪字段', () => {
    const sources = parseSearchSources({
      results: [
        { url: 'https://example.com/a', title: 't'.repeat(600), content: 'c'.repeat(2_100), score: 0.9 },
        { url: 'ftp://example.com/b' },
        { url: 'http://example.com/c', title: '', score: 'not-a-number' },
        '不是对象',
      ],
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]?.title).toHaveLength(500);
    expect(sources[0]?.content).toHaveLength(2_000);
    expect(sources[0]?.score).toBe(0.9);
    expect(sources[1]?.title).toBe('未命名来源');
    expect(sources[1]?.score).toBeNull();
  });

  it('提取结果正文裁剪到 1500 字符并忽略非法项', () => {
    const extracted = parseExtractedSources({
      results: [
        { url: 'https://example.com/a', raw_content: 'x'.repeat(2_000) },
        { url: 'ftp://example.com/b', raw_content: 'text' },
        { url: 'https://example.com/c' },
      ],
    });

    expect(extracted).toHaveLength(1);
    expect(extracted[0]?.rawContent).toHaveLength(1_500);
  });

  it('暴露给模型的工具定义与 Python 一致', () => {
    expect(TAVILY_SEARCH_TOOL.name).toBe('tavily_search');
    expect(TAVILY_SEARCH_TOOL.parameters).toMatchObject({
      required: ['query'],
      additionalProperties: false,
    });
  });
});
