/**
 * Tavily Redis 熔断器单元测试。
 *
 * 覆盖 Closed 放行、Open 拒绝、Half-Open 探测以及 Redis 不可用的 fail-closed 行为。
 */
import { describe, expect, it } from 'vitest';

import {
  RedisToolCircuitBreaker,
  ToolCircuitBreakerUnavailableError,
  type ToolCircuitBreakerOptions,
} from '../src/infrastructure/redis/tool-circuit-breaker.js';

const OPTIONS: ToolCircuitBreakerOptions = {
  failureThreshold: 3,
  failureWindowSeconds: 60,
  cooldownSeconds: 60,
  probeLeaseSeconds: 30,
  keyPrefix: 'circuit:test:',
};

class FakeRedis {
  commands: string[][] = [];
  result: string | number | null = 1;
  error: Error | null = null;

  /** 记录 Redis Lua 命令并返回预设结果。 */
  async command(...args: string[]): Promise<string | number | null> {
    this.commands.push(args);
    if (this.error !== null) throw this.error;
    return this.result;
  }
}

describe('RedisToolCircuitBreaker', () => {
  it('Closed 状态放行普通调用并记录成功', async () => {
    const redis = new FakeRedis();
    const breaker = new RedisToolCircuitBreaker(redis as never, OPTIONS);
    const lease = await breaker.acquire();
    expect(lease).toEqual({ probe: false });
    await breaker.recordSuccess(lease!);
    expect(redis.commands).toHaveLength(2);
    expect(redis.commands[0]?.[0]).toBe('EVAL');
    expect(redis.commands[1]?.[0]).toBe('EVAL');
  });

  it('Open 状态拒绝普通调用', async () => {
    const redis = new FakeRedis();
    redis.result = 0;
    const breaker = new RedisToolCircuitBreaker(redis as never, OPTIONS);
    await expect(breaker.acquire()).resolves.toBeNull();
  });

  it('Half-Open 状态放行探测调用', async () => {
    const redis = new FakeRedis();
    redis.result = 2;
    const breaker = new RedisToolCircuitBreaker(redis as never, OPTIONS);
    const lease = await breaker.acquire();
    expect(lease).toEqual({ probe: true });
    await breaker.recordFailure(lease!);
    expect(redis.commands[1]?.[0]).toBe('EVAL');
  });

  it('Redis 不可用时 fail-closed', async () => {
    const redis = new FakeRedis();
    redis.error = new Error('redis down');
    const breaker = new RedisToolCircuitBreaker(redis as never, OPTIONS);
    await expect(breaker.acquire()).rejects.toBeInstanceOf(ToolCircuitBreakerUnavailableError);
  });
});
