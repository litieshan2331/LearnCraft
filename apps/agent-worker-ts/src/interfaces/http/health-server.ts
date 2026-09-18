/**
 * TypeScript Agent 服务的健康与就绪端点（替代 Python FastAPI 仅剩的 /health 面）。
 *
 * 职责：用 node:http 起一个极小的 HTTP 服务，暴露两个端点：
 * - `GET /health`：存活探测，返回与 Python ServiceStatusResponse 同形的字段
 *   （status / service / version / git_sha），并附带本进程的运行时信息（由 details 提供）。
 * - `GET /ready`：就绪探测，执行调用方注入的依赖检查（数据库与队列 Redis），失败返回 503，
 *   供 compose healthcheck 与运维在 Python 下线后判断 Agent 侧是否可用。
 *
 * 设计取舍：只做只读探测，不暴露任何业务接口，也不需要鉴权；除 node:http 外不引入依赖。
 *
 * 导出：
 * - HealthServerOptions / ReadinessResult：端点配置与就绪检查结果。
 * - createReadinessChecker：把一组探测函数包装为就绪检查。
 * - startHealthServer：启动服务并返回关闭句柄。
 */

import http from 'node:http';

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, boolean>;
}

export interface HealthServerOptions {
  /** 服务名，例如 agent-worker-ts。 */
  service: string;
  port: number;
  host: string;
  /** 存活响应附带的运行时信息（例如已注册的 run_type），不应包含任何密钥。 */
  details?: () => Record<string, unknown>;
  /** 就绪检查；未提供时 /ready 只反映进程存活。 */
  readiness?: () => Promise<ReadinessResult>;
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/** 把一组探测函数包装为就绪检查：任一失败即为未就绪，且不抛异常。 */
export function createReadinessChecker(
  probes: Record<string, () => Promise<void>>,
): () => Promise<ReadinessResult> {
  return async () => {
    const checks: Record<string, boolean> = {};
    let ready = true;
    for (const [name, probe] of Object.entries(probes)) {
      try {
        await probe();
        checks[name] = true;
      } catch {
        checks[name] = false;
        ready = false;
      }
    }
    return { ready, checks };
  };
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** 启动健康端点；端口被占用等错误会以异常抛出，由进程入口决定是否终止。 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const startedAt = Date.now();
  const version = process.env.APP_VERSION?.trim() || '0.1.0';
  const gitSha = process.env.GIT_SHA?.trim() || 'unknown';

  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (path === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        service: options.service,
        version,
        git_sha: gitSha,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1_000),
        ...(options.details === undefined ? {} : options.details()),
      });
      return;
    }
    if (path === '/ready') {
      const readiness = options.readiness;
      if (readiness === undefined) {
        sendJson(response, 200, { status: 'ready', service: options.service, checks: {} });
        return;
      }
      void readiness()
        .then((result) => {
          sendJson(response, result.ready ? 200 : 503, {
            status: result.ready ? 'ready' : 'not_ready',
            service: options.service,
            checks: result.checks,
          });
        })
        .catch(() => {
          sendJson(response, 503, {
            status: 'not_ready',
            service: options.service,
            checks: {},
          });
        });
      return;
    }
    sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
