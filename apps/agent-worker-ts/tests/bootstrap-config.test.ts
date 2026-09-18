/**
 * 配置读取的单元测试：Redis 连接串解析与运行时路由映射。
 */
import { describe, expect, it } from 'vitest';

import { parseRedisConnection } from '../src/bootstrap/config.js';

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

