/**
 * 最小 RESP 客户端的测试：连接串解析始终运行；真实读写需要本地 Redis 才会执行。
 *
 * 开启真实读写（可选）：
 *   AGENT_TS_TEST_REDIS_URL=redis://:password@127.0.0.1:6380/0
 */
import { describe, expect, it } from 'vitest';

import { RespRedisClient, RespRedisError, parseRedisUrl } from '../src/infrastructure/redis/resp-client.js';

const redisUrl = process.env.AGENT_TS_TEST_REDIS_URL;
const liveEnabled = typeof redisUrl === 'string' && redisUrl.length > 0;

describe('连接串解析', () => {
  it('解析主机、端口、密码与 db', () => {
    expect(parseRedisUrl('redis://:secret@127.0.0.1:6380/0')).toEqual({
      host: '127.0.0.1',
      port: 6380,
      password: 'secret',
      username: null,
      database: 0,
    });
    expect(parseRedisUrl('redis://user:secret@example.internal/2')).toEqual({
      host: 'example.internal',
      port: 6379,
      password: 'secret',
      username: 'user',
      database: 2,
    });
    expect(parseRedisUrl('redis://127.0.0.1')).toMatchObject({ password: null, database: 0 });
  });

  it('拒绝非法协议、缺少主机与非法 db', () => {
    expect(() => parseRedisUrl('http://127.0.0.1')).toThrow(RespRedisError);
    expect(() => parseRedisUrl('rediss://127.0.0.1')).toThrow(RespRedisError);
    expect(() => parseRedisUrl('redis://')).toThrow(RespRedisError);
    expect(() => parseRedisUrl('不是 URL')).toThrow(RespRedisError);
  });
});

describe.skipIf(!liveEnabled)('真实 Redis 命令', () => {
  it('完成 INCR / EXPIRE / DECR 并在结束时清理键', async () => {
    const client = new RespRedisClient({ url: redisUrl as string });
    const key = 'learncraft:test:resp:' + String(Date.now());

    try {
      expect(await client.command('INCR', key)).toBe(1);
      expect(await client.command('INCR', key)).toBe(2);
      expect(await client.command('EXPIRE', key, '60')).toBe(1);
      expect(await client.command('DECR', key)).toBe(1);
      expect(await client.command('GET', '不存在的键')).toBeNull();
      expect(await client.command('DEL', key)).toBe(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('密码错误时抛出 RespRedisError', async () => {
    const client = new RespRedisClient({ url: 'redis://:wrong-password@127.0.0.1:6380/0', commandTimeoutMs: 2_000 });
    await expect(client.command('PING')).rejects.toThrow(RespRedisError);
    await client.close();
  }, 20_000);
});
