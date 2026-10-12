/**
 * 最小 RESP 客户端的测试：连接串解析始终运行；真实读写需要本地 Redis 才会执行。
 *
 * 开启真实读写（可选）：
 *   AGENT_TS_TEST_REDIS_URL=redis://:password@127.0.0.1:6380/0
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';

import { RespRedisClient, RespRedisError, parseRedisUrl } from '../src/infrastructure/redis/resp-client.js';

const redisUrl = process.env.AGENT_TS_TEST_REDIS_URL;
const liveEnabled = typeof redisUrl === 'string' && redisUrl.length > 0;

describe('命令超时后的协议边界', () => {
  /** 模拟旧命令迟到成功回复，下一条命令必须建立新连接以免误判续期。 */
  it('丢弃超时连接，不把旧回复误认为新命令的结果', async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      const sequence = ++connections;
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        if (sequence === 1) {
          const timer = setTimeout(() => socket.write(':1\r\n'), 150);
          socket.once('close', () => clearTimeout(timer));
        } else socket.write('+PONG\r\n');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听');
    const client = new RespRedisClient({ url: 'redis://127.0.0.1:' + address.port, commandTimeoutMs: 40 });
    try {
      await expect(client.command('EVAL', 'return 1', '0')).rejects.toThrow(/超时/);
      expect(await client.command('PING')).toBe('PONG');
      expect(connections).toBe(2);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

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
