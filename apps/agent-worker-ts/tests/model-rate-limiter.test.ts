/**
 * 模型 Redis 限流器单元测试。
 *
 * 覆盖：原子 EVAL 参数包含全局、API Key+模型、用户+模型三类并发桶；
 * RPM 与并发使用不同窗口；成功租约可释放且重复释放不会重复扣减；额度不足与 Redis 异常均返回受控错误。
 */
import { describe, expect, it } from 'vitest';

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
    expect(redis.commands[0]?.slice(-7)).toEqual(['8', '2', '2', '30', '10', '180', '60']);

    await lease.release();
    await lease.release();
    expect(redis.commands).toHaveLength(2);
    expect(redis.commands[1]?.[0]).toBe('EVAL');
    expect(redis.commands[1]?.[2]).toBe('3');
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
});
