/**
 * 配置读取的单元测试：Redis 连接串解析与运行时路由映射。
 */
import { describe, expect, it } from 'vitest';

import { parseRedisConnection, readAgentQueuePoolConfigs, readModelRateLimitSettings, readModelGatewayRequestMaxRetries, readTavilyCircuitBreakerSettings } from '../src/bootstrap/config.js';

describe('parseRedisConnection', () => {
  it('解析主机、端口、密码与数据库编号', () => {
    expect(parseRedisConnection('redis://:secret@celery-redis:6380/2')).toEqual({
      host: 'celery-redis',
      port: 6380,
      db: 2,
      password: 'secret',
    });
  });

  it('缺省端口与库号时使用 6379 与 0', () => {
    expect(parseRedisConnection('redis://localhost')).toEqual({ host: 'localhost', port: 6379, db: 0 });
  });

  it('拒绝非 redis 协议与非法地址', () => {
    expect(() => parseRedisConnection('http://localhost:6379')).toThrow(/redis:\/\//);
    expect(() => parseRedisConnection('不是地址')).toThrow(/不合法/);
  });
});


describe('readAgentQueuePoolConfigs', () => {
  it('沿用原队列处理短任务，并为长任务配置独立队列与并发', () => {
    const previous = {
      url: process.env.AGENT_QUEUE_REDIS_URL,
      shortQueue: process.env.AGENT_SHORT_QUEUE_NAME,
      longQueue: process.env.AGENT_LONG_QUEUE_NAME,
      shortConcurrency: process.env.AGENT_SHORT_WORKER_CONCURRENCY,
      longConcurrency: process.env.AGENT_LONG_WORKER_CONCURRENCY,
    };
    try {
      process.env.AGENT_QUEUE_REDIS_URL = 'redis://localhost:6379/0';
      process.env.AGENT_SHORT_QUEUE_NAME = 'agent.run';
      process.env.AGENT_LONG_QUEUE_NAME = 'agent.run.long';
      process.env.AGENT_SHORT_WORKER_CONCURRENCY = '3';
      process.env.AGENT_LONG_WORKER_CONCURRENCY = '2';
      const configs = readAgentQueuePoolConfigs();
      expect(configs.short.queueName).toBe('agent.run');
      expect(configs.long.queueName).toBe('agent.run.long');
      expect(configs.short.concurrency).toBe(3);
      expect(configs.long.concurrency).toBe(2);
      expect(configs.short.connection).toEqual(configs.long.connection);
      process.env.AGENT_LONG_QUEUE_NAME = 'agent.run';
      expect(() => readAgentQueuePoolConfigs()).toThrow(/不能同名/);
    } finally {
      for (const [name, value] of Object.entries({
        AGENT_QUEUE_REDIS_URL: previous.url,
        AGENT_SHORT_QUEUE_NAME: previous.shortQueue,
        AGENT_LONG_QUEUE_NAME: previous.longQueue,
        AGENT_SHORT_WORKER_CONCURRENCY: previous.shortConcurrency,
        AGENT_LONG_WORKER_CONCURRENCY: previous.longConcurrency,
      })) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});


describe('readModelRateLimitSettings', () => {
  it('读取 v1 限流默认值', () => {
    const names = [
      'MODEL_RATE_LIMIT_GLOBAL_CONCURRENCY',
      'MODEL_RATE_LIMIT_API_KEY_CONCURRENCY',
      'MODEL_RATE_LIMIT_API_KEY_RPM',
      'MODEL_RATE_LIMIT_USER_CONCURRENCY',
      'MODEL_RATE_LIMIT_USER_RPM',
      'MODEL_RATE_LIMIT_LEASE_TTL_SECONDS',
      'MODEL_RATE_LIMIT_KEY_PREFIX',
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        delete process.env[name];
      }
      expect(readModelRateLimitSettings()).toEqual({
        globalConcurrency: 8,
        apiKeyConcurrency: 2,
        apiKeyRpm: 30,
        userConcurrency: 2,
        userRpm: 10,
        leaseTtlSeconds: 180,
        keyPrefix: 'ratelimit:llm:',
      });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});


describe('模型重试与工具熔断配置', () => {
  it('模型网关重试限制在 1 到 2 次', () => {
    const previous = process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES;
    try {
      process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES = '5';
      expect(readModelGatewayRequestMaxRetries()).toBe(2);
      process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES = '0';
      expect(readModelGatewayRequestMaxRetries()).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES;
      else process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES = previous;
    }
  });

  it('读取工具熔断器默认阈值', () => {
    const names = [
      'TAVILY_CIRCUIT_FAILURE_THRESHOLD',
      'TAVILY_CIRCUIT_FAILURE_WINDOW_SECONDS',
      'TAVILY_CIRCUIT_COOLDOWN_SECONDS',
      'TAVILY_CIRCUIT_PROBE_LEASE_SECONDS',
      'TAVILY_CIRCUIT_KEY_PREFIX',
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(readTavilyCircuitBreakerSettings()).toEqual({
        failureThreshold: 3,
        failureWindowSeconds: 60,
        cooldownSeconds: 60,
        probeLeaseSeconds: 30,
        keyPrefix: 'circuit:tool:',
      });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
