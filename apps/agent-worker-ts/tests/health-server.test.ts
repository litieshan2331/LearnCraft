/**
 * 健康与就绪端点的单元测试（真实监听回环端口，端口 0 由系统分配）。
 *
 * 重点固化：/health 的字段形状与 Python ServiceStatusResponse 一致、details 会并入响应、
 * /ready 在依赖失败时返回 503 且不抛异常、未知路径与非法方法的状态码，以及 close 后端口释放。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createReadinessChecker,
  startHealthServer,
  type HealthServer,
  type HealthServerOptions,
} from '../src/interfaces/http/health-server.js';

let server: HealthServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(options: Omit<HealthServerOptions, 'port'>): Promise<string> {
  server = await startHealthServer({ ...options, port: 0 });
  return 'http://127.0.0.1:' + String(server.port);
}

describe('健康端点', () => {
  it('/health 返回存活信息与运行时细节', async () => {
    const url = await start({
      service: 'agent-worker-ts',
      host: '127.0.0.1',
      details: () => ({ registered_run_types: ['plan_generate'], queue: 'agent.run' }),
    });

    const response = await fetch(url + '/health');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      service: 'agent-worker-ts',
      registered_run_types: ['plan_generate'],
      queue: 'agent.run',
    });
    expect(typeof body.version).toBe('string');
    expect(typeof body.git_sha).toBe('string');
    expect(typeof body.uptime_seconds).toBe('number');
  });

  it('/ready 在依赖正常时返回 200，失败时返回 503 且不抛异常', async () => {
    let healthy = true;
    const url = await start({
      service: 'agent-worker-ts',
      host: '127.0.0.1',
      readiness: createReadinessChecker({
        database: async () => undefined,
        queue_redis: async () => {
          if (!healthy) {
            throw new Error('Redis 不可用');
          }
        },
      }),
    });

    const ok = await fetch(url + '/ready');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'ready', checks: { database: true, queue_redis: true } });

    healthy = false;
    const failed = await fetch(url + '/ready');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: true, queue_redis: false },
    });
  });

  it('未提供就绪检查时只反映进程存活', async () => {
    const url = await start({ service: 'agent-dispatcher-ts', host: '127.0.0.1' });

    const response = await fetch(url + '/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', checks: {} });
  });

  it('未知路径返回 404，非 GET 返回 405', async () => {
    const url = await start({ service: 'agent-worker-ts', host: '127.0.0.1' });

    const notFound = await fetch(url + '/metrics');
    expect(notFound.status).toBe(404);

    const methodNotAllowed = await fetch(url + '/health', { method: 'POST' });
    expect(methodNotAllowed.status).toBe(405);
  });

  it('close 之后端口不再接受连接', async () => {
    const url = await start({ service: 'agent-worker-ts', host: '127.0.0.1' });
    expect((await fetch(url + '/health')).status).toBe(200);

    await server?.close();
    server = null;

    await expect(fetch(url + '/health')).rejects.toThrow();
  });
});
