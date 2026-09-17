/**
 * 端到端传输测试：在回环地址上起一个 HTTPS 服务，验证“连接钉死 IP + 按原域名做 SNI 与证书校验”。
 *
 * 这是 §8.1 实测结论的回归固化：证书只签了 api.example.com，客户端却连接 127.0.0.1。
 * 服务端在请求处理里读 socket.servername，因此可以断言 SNI 确实按域名发送、且证书校验遵循域名而非 IP。
 *
 * 夹具证书仅用于测试（tests/fixtures/test-only-*.pem），不是任何真实环境凭据。
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { createServer as createTcpServer, connect as netConnect, type Server as TcpServer } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SafeModelEgressClient,
  createNodePinnedRequester,
  type ModelEgressAuditWriter,
  type ModelEgressOptions,
} from '../src/infrastructure/llm/safe-egress-client.js';
import type { EgressEndpointPolicy, ResolvedEndpoint } from '../src/infrastructure/llm/egress-policy.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const testCert = readFileSync(join(fixtureDir, 'test-only-cert.pem'), 'utf8');
const testKey = readFileSync(join(fixtureDir, 'test-only-key.pem'), 'utf8');

interface ObservedRequest {
  servername: string | null;
  hostHeader: string | null;
  /**
   * 注意：服务端 socket.authorized 表示“客户端证书已验证”（双向 TLS），本项目不使用客户端证书，
   * 因此它恒为 false，不能用来判断客户端是否校验了服务端证书。服务端证书校验的结果体现在
   * 客户端请求是否成功：证书不匹配时握手会失败（见本文件第二个用例）。
   */
  clientCertificateAuthorized: boolean;
  url: string | undefined;
}

const observed: ObservedRequest[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer({ cert: testCert, key: testKey }, (request, response) => {
    const tlsSocket = request.socket as TLSSocket;
    observed.push({
      servername: typeof tlsSocket.servername === 'string' ? tlsSocket.servername : null,
      hostHeader: request.headers.host ?? null,
      clientCertificateAuthorized: tlsSocket.authorized === true,
      url: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 最小 CONNECT 代理：记录它看到的 CONNECT 目标，并把字节流转发给目标。 */
const proxyTargets: string[] = [];
const proxySockets = new Set<import('node:net').Socket>();
let proxy: TcpServer;
let proxyPort = 0;

beforeAll(async () => {
  proxy = createTcpServer((client) => {
    proxySockets.add(client);
    client.on('close', () => proxySockets.delete(client));
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) {
        return;
      }
      client.removeListener('data', onData);
      const target = buffer.split('\r\n')[0]?.split(' ')[1] ?? '';
      proxyTargets.push(target);
      const separator = target.lastIndexOf(':');
      const upstream = netConnect(Number(target.slice(separator + 1)), target.slice(0, separator), () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  proxyPort = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  // 隧道会一直保持双向管道，必须先销毁在飞 socket，否则 close() 永不回调。
  for (const socket of proxySockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

function endpoint(hostname: string): ResolvedEndpoint {
  return { baseUrl: 'https://' + hostname, hostname, port, pinnedIp: '127.0.0.1' };
}

function policyFor(target: ResolvedEndpoint): EgressEndpointPolicy {
  return { resolveEndpoint: async () => target };
}

const silentAudit: ModelEgressAuditWriter = { record: async () => {} };

const options: ModelEgressOptions = {
  enabled: true,
  proxyUrl: null,
  connectTimeoutMs: 2000,
  readTimeoutMs: 2000,
  maxResponseBytes: 64 * 1024,
};

function callWith(hostname: string) {
  const client = new SafeModelEgressClient(options, silentAudit, policyFor(endpoint(hostname)), createNodePinnedRequester());
  return client.postOpenAiCompatibleJson({
    ownerId: 'owner-1',
    modelConnectionId: 'connection-1',
    agentRunId: 'run-1',
    baseUrl: 'https://' + hostname,
    apiKey: 'sk-secret-key',
    endpointSegments: ['v1', 'chat', 'completions'],
    payload: { model: 'demo-model', stream: true },
    ca: testCert,
  });
}

describe('经 CONNECT 代理的钉死 IP + 原域名 SNI/证书校验（端到端）', () => {
  it('代理只看到钉死 IP，TLS 校验仍按原域名进行', async () => {
    observed.length = 0;
    proxyTargets.length = 0;
    const target = endpoint('api.example.com');
    const client = new SafeModelEgressClient(
      { ...options, proxyUrl: 'http://127.0.0.1:' + String(proxyPort) },
      silentAudit,
      policyFor(target),
      createNodePinnedRequester(),
    );

    const result = await client.postOpenAiCompatibleJson({
      ownerId: 'owner-1',
      modelConnectionId: 'connection-1',
      agentRunId: 'run-1',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret-key',
      endpointSegments: ['v1', 'chat', 'completions'],
      payload: { model: 'demo-model', stream: true },
      ca: testCert,
    });

    expect(result.statusCode).toBe(200);
    // 与 Python 现状一致：CONNECT 目标是钉死 IP，代理看不到域名。
    expect(proxyTargets).toEqual(['127.0.0.1:' + String(port)]);
    expect(observed[0]?.servername).toBe('api.example.com');
    expect(observed[0]?.hostHeader).toBe('api.example.com');
    expect(observed[0]?.url).toBe('/v1/chat/completions');
  });
});

describe('钉死 IP + 原域名 SNI/证书校验（端到端）', () => {
  it('连接 127.0.0.1 但 SNI 与 Host 都是 api.example.com，且证书校验通过', async () => {
    observed.length = 0;
    const result = await callWith('api.example.com');

    expect(result.statusCode).toBe(200);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.servername).toBe('api.example.com');
    expect(observed[0]?.hostHeader).toBe('api.example.com');
    expect(observed[0]?.url).toBe('/v1/chat/completions');
    // 请求成功本身即证明客户端用 api.example.com 校验了证书：
    // 目标地址是 127.0.0.1，而证书只签了 api.example.com，若校验对着 IP 进行必然失败。
    expect(observed[0]?.clientCertificateAuthorized).toBe(false);
  });

  it('servername 与证书不匹配时握手失败（证明证书校验跟随域名而非 IP）', async () => {
    const result = callWith('evil.example.com');
    await expect(result).rejects.toMatchObject({
      code: 'MODEL_EGRESS_HTTP_ERROR',
      providerErrorCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });
});
