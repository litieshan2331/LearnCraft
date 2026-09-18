/**
 * 真实 Tavily 远程 MCP 冒烟（会消耗真实的 Tavily 配额，必须显式开启）。
 *
 * 覆盖风险最高的传输与配额部分：官方 MCP 端点的 initialize/tools-list/tools-call 往返、
 * Bearer 鉴权、DEFAULT_PARAMETERS、搜索结果与提取结果的字段收敛、以及 Redis 每日配额计数。
 * 本用例不调用生成模型，因此不产生模型费用。
 *
 * 开启方式（全部设置后才会运行）：
 *   AGENT_TS_LIVE_E2E=1
 *   TAVILY_API_KEY=<真实 Key>
 *   TAVILY_QUOTA_REDIS_URL=redis://:password@127.0.0.1:6380/0
 *
 * 用例会自行清理本次创建的配额键。
 */
import { describe, expect, it } from 'vitest';

import { RedisDailyQuotaCounter, TavilyToolGateway } from '../../src/infrastructure/mcp/tavily-tool-gateway.js';
import { RespRedisClient } from '../../src/infrastructure/redis/resp-client.js';

const apiKey = process.env.TAVILY_API_KEY;
const quotaUrl = process.env.TAVILY_QUOTA_REDIS_URL;
const enabled =
  process.env.AGENT_TS_LIVE_E2E === '1'
  && typeof apiKey === 'string' && apiKey.length > 0
  && typeof quotaUrl === 'string' && quotaUrl.length > 0;

const OWNER_ID = '9f6a1f52-1f0f-4f2a-9d3f-6f0c1c2d3e4f';
const QUOTA_PREFIX = 'ratelimit:tavily:live-test:';

function buildGateway(options: { dailyLimit?: number; ownerId?: string | null; prefix?: string } = {}) {
  return new TavilyToolGateway({
    settings: {
      apiKey: apiKey as string,
      ownerId: options.ownerId === undefined ? OWNER_ID : options.ownerId,
      dailyLimit: options.dailyLimit ?? 5,
      quotaKeyPrefix: options.prefix ?? QUOTA_PREFIX,
      searchMaxResults: 5,
      extractTopResults: 2,
      extractChunksPerSource: 3,
      proxyUrl: null,
    },
    quota: new RedisDailyQuotaCounter(quotaUrl as string),
  });
}

describe.skipIf(!enabled)('真实 Tavily 远程 MCP', () => {
  it('完成一次真实搜索+提取，并写入 Redis 配额计数', async () => {
    const client = new RespRedisClient({ url: quotaUrl as string });
    const day = new Date().toISOString().slice(0, 10);
    const quotaKey = QUOTA_PREFIX + OWNER_ID + ':' + day;

    try {
      await client.command('DEL', quotaKey);

      const result = await buildGateway().execute({
        id: 'live-call-1',
        name: 'tavily_search',
        argumentsJson: JSON.stringify({ query: 'Python 函数 参数 官方教程' }),
      });

      console.log('  · 工具结果：code=' + result.code + '，ok=' + String(result.ok));
      expect(result.ok).toBe(true);
      expect(result.code).toBe('TAVILY_SEARCH_EXTRACT_OK');
      expect(result.data.content_is_untrusted).toBe(true);

      const sources = result.data.sources as Array<Record<string, unknown>>;
      expect(sources.length).toBeGreaterThanOrEqual(1);
      expect(sources.length).toBeLessThanOrEqual(2);
      for (const [index, source] of sources.entries()) {
        expect(source.rank).toBe(index + 1);
        expect(String(source.url)).toMatch(/^https?:\/\//);
        expect(String(source.title).length).toBeGreaterThan(0);
        expect(String(source.content).length).toBeGreaterThan(0);
        expect(String(source.content).length).toBeLessThanOrEqual(1_500);
      }
      console.log('  · 来源：' + JSON.stringify(sources.map((source) => ({
        rank: source.rank,
        url: source.url,
        title: String(source.title).slice(0, 40),
        contentLength: String(source.content).length,
      }))));
      console.log('  · 提取失败来源：' + JSON.stringify(result.data.failed_sources));

      const quotaValue = await client.command('GET', quotaKey);
      expect(quotaValue).toBe('1');
      console.log('  · 配额计数=' + String(quotaValue));
    } finally {
      await client.command('DEL', quotaKey);
      await client.close();
    }
  }, 120_000);

  it('超过每日额度时拒绝调用并回滚计数', async () => {
    const client = new RespRedisClient({ url: quotaUrl as string });
    const day = new Date().toISOString().slice(0, 10);
    const quotaKey = QUOTA_PREFIX + OWNER_ID + ':' + day;

    try {
      await client.command('DEL', quotaKey);
      // dailyLimit=0：第一次自增即超过额度，网关应回滚并拒绝。
      const result = await buildGateway({ dailyLimit: 0 }).execute({
        id: 'live-call-2',
        name: 'tavily_search',
        argumentsJson: JSON.stringify({ query: '不应真正发起的查询' }),
      });

      expect(result).toMatchObject({ ok: false, code: 'TAVILY_DAILY_QUOTA_EXCEEDED' });
      expect(await client.command('GET', quotaKey)).toBe('0');
    } finally {
      await client.command('DEL', quotaKey);
      await client.close();
    }
  }, 60_000);

  it('未配置账户或 Key 时返回受控错误，不发起联网', async () => {
    const noOwner = await buildGateway({ ownerId: null }).execute({
      id: 'live-call-3',
      name: 'tavily_search',
      argumentsJson: JSON.stringify({ query: 'Python' }),
    });
    expect(noOwner).toMatchObject({ ok: false, code: 'TAVILY_QUOTA_UNAVAILABLE' });

    const noKey = new TavilyToolGateway({
      settings: {
        apiKey: null,
        ownerId: OWNER_ID,
        dailyLimit: 5,
        quotaKeyPrefix: QUOTA_PREFIX,
        searchMaxResults: 5,
        extractTopResults: 2,
        extractChunksPerSource: 3,
        proxyUrl: null,
      },
      quota: { increment: async () => 1, decrement: async () => undefined },
    });
    const keyMissing = await noKey.execute({
      id: 'live-call-4',
      name: 'tavily_search',
      argumentsJson: JSON.stringify({ query: 'Python' }),
    });
    expect(keyMissing).toMatchObject({ ok: false, code: 'TAVILY_API_KEY_MISSING' });
  }, 60_000);
});
