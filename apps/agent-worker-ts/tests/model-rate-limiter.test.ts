/**
 * 模型 Redis 限流器单元测试。
 *
 * 覆盖：原子 EVAL 参数包含全局、API Key+模型、用户+模型三类并发桶；
 * RPM 与并发使用不同窗口；成功租约可释放且重复释放不会重复扣减；额度不足与 Redis 异常均返回受控错误。
 */
import { describe, expect, it, vi } from 'vitest';

import { RespRedisError } from '../src/infrastructure/redis/resp-client.js';
import {
  ModelRateLimitError,
  RedisModelRateLimiter,
  type ModelRateLimitOptions,
} from '../src/infrastructure/redis/model-rate-limiter.js';

const OPTIONS: ModelRateLimitOptions = {
  globalConcurrency: 8,
  apiKeyConcurrency: 2,
  apiKeyRpm: 30,
  userConcurrency: 2,
  userRpm: 10,
  leaseTtlSeconds: 180,
  keyPrefix: 'ratelimit:llm:',
};

class FakeRedis {
  readonly commands: string[][] = [];
  result: string | number | null = 1;
  error: Error | null = null;

  /** 记录 EVAL 命令并返回测试预设结果。 */
  async command(...args: string[]): Promise<string | number | null> {
    this.commands.push(args);
    if (this.error !== null) {
      throw this.error;
    }
    if (args[2] === '5' && this.result === 1) {
      return JSON.stringify({ window: 123, lease_id: args.at(-1) });
    }
    return this.result;
  }
}

describe('RedisModelRateLimiter', () => {
  it('获取租约时同时包含全局、API Key+模型、用户+模型和两个 RPM 桶', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisModelRateLimiter(redis as never, OPTIONS);

    const lease = await limiter.acquire({ ownerId: 'user-1', modelId: 'model-x', apiKey: 'secret-key' });

    expect(redis.commands).toHaveLength(1);
    expect(redis.commands[0]?.[0]).toBe('EVAL');
    expect(redis.commands[0]?.[2]).toBe('5');
    expect(redis.commands[0]?.slice(3, 8)).toHaveLength(5);
    expect(redis.commands[0]?.slice(3).some((value) => value.includes('secret-key'))).toBe(false);
    expect(redis.commands[0]?.slice(3).some((value) => value.includes('model-x'))).toBe(false);
    expect(redis.commands[0]?.slice(-7, -1)).toEqual(['8', '2', '2', '30', '10', '180000']);
    expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lease.window).toBe(123);

    await lease.release();
    await lease.release();
    expect(redis.commands).toHaveLength(2);
    expect(redis.commands[1]?.[0]).toBe('EVAL');
    expect(redis.commands[1]?.[2]).toBe('3');
    expect(redis.commands[1]?.at(-1)).toBe(lease.leaseId);
  });

  it('Redis 返回 0 时报告额度已满', async () => {
    const redis = new FakeRedis();
    redis.result = 0;
    const limiter = new RedisModelRateLimiter(redis as never, OPTIONS);

    await expect(
      limiter.acquire({ ownerId: 'user-1', modelId: 'model-x', apiKey: 'secret-key' }),
    ).rejects.toMatchObject({
      code: 'MODEL_RATE_LIMIT_EXCEEDED',
    } satisfies Partial<ModelRateLimitError>);
  });

  it('Redis 异常时报告限流不可用', async () => {
    const redis = new FakeRedis();
    redis.error = new RespRedisError('连接失败');
    const limiter = new RedisModelRateLimiter(redis as never, OPTIONS);

    await expect(
      limiter.acquire({ ownerId: 'user-1', modelId: 'model-x', apiKey: 'secret-key' }),
    ).rejects.toMatchObject({
      code: 'MODEL_RATE_LIMIT_UNAVAILABLE',
    } satisfies Partial<ModelRateLimitError>);
  });

  it('拒绝非正整数配置', () => {
    const redis = new FakeRedis();
    expect(() => new RedisModelRateLimiter(redis as never, { ...OPTIONS, userRpm: 0 })).toThrow(/正整数/);
  });

  /** 续期失去许可时中止模型请求，释放仍只按独立 ID 删除。 */
  it('续期被拒绝后中止信号且不复活许可', async () => {
    const redis = new FakeRedis();
    const lease = await new RedisModelRateLimiter(redis as never, OPTIONS).acquire({ ownerId: 'u', modelId: 'm', apiKey: 'k' });
    redis.result = 0;
    await expect(lease.renew?.()).rejects.toMatchObject({ code: 'MODEL_RATE_LIMIT_LEASE_LOST' });
    expect(lease.signal?.aborted).toBe(true);
    await lease.release();
    expect(redis.commands.at(-1)?.at(-1)).toBe(lease.leaseId);
  });

  /** Redis 无法续期时主动中止，而不是继续使用本地旧额度。 */
  it('续期 Redis 故障后中止信号', async () => {
    const redis = new FakeRedis();
    const lease = await new RedisModelRateLimiter(redis as never, OPTIONS).acquire({ ownerId: 'u', modelId: 'm', apiKey: 'k' });
    redis.error = new Error('Redis unavailable');
    await expect(lease.renew?.()).rejects.toMatchObject({ code: 'MODEL_RATE_LIMIT_UNAVAILABLE' });
    expect(lease.signal?.aborted).toBe(true);
    await lease.release();
  });

  /** 定时续期卡住时在保守截止时间中止，迟到成功不能复活许可。 */
  it('续期响应挂起时截止计时生效，迟到响应不能恢复信号', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    let resolveRenewal: ((value: number) => void) | undefined;
    const lease = await new RedisModelRateLimiter(redis as never, { ...OPTIONS, leaseTtlSeconds: 1 }).acquire({ ownerId: 'u', modelId: 'm', apiKey: 'k' });
    try {
      redis.command = async () => new Promise<number>((resolve) => { resolveRenewal = resolve; });
      await vi.advanceTimersByTimeAsync(333);
      expect(resolveRenewal).toBeDefined();
      await vi.advanceTimersByTimeAsync(467);
      expect(lease.signal?.aborted).toBe(true);
      expect(lease.signal?.reason).toMatchObject({ code: 'MODEL_RATE_LIMIT_LEASE_LOST' });
      resolveRenewal!(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(lease.renew?.()).rejects.toMatchObject({ code: 'MODEL_RATE_LIMIT_LEASE_LOST' });
      redis.command = async () => 1;
    } finally {
      resolveRenewal?.(1);
      redis.command = async () => 1;
      await lease.release();
      vi.useRealTimers();
    }
  });
});
