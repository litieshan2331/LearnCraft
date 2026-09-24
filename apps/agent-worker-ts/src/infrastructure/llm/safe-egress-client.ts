/**
 * 受控模型出网客户端（等价于 Python 的 SafeModelEgressClient 核心行为）。
 *
 * 职责：在策略校验通过后，以“已验证 IP + 原域名 SNI/证书校验 + 显式 Host 头”的方式发起模型请求，
 * 并保证：禁止重定向、响应体按解压后字节计数上限、SSE 必须是 data-only 且以 [DONE] 结束、
 * 出网前先写 allowed 审计且写失败即拒绝（fail-closed）、错误按稳定错误码分类并标注可重试性。
 *
 * 导出：
 * - ModelEgressOptions / ModelEgressAuditEntry / ModelEgressAuditWriter：配置与审计端口。
 * - ModelEgressRequestError：带稳定错误码与 retryable 的异常。
 * - PinnedRequestOptions / PinnedHttpResponse / PinnedRequester：可注入的传输层端口。
 * - createNodePinnedRequester：基于 node:net/node:tls/node:https 的实现，支持直连与 CONNECT 代理。
 * - SafeModelEgressClient：postOpenAiCompatibleJson / postOpenAiCompatibleSse。
 */

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { PassThrough, Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ModelEgressPolicy, ModelEgressPolicyError, type EgressEndpointPolicy, type ResolvedEndpoint } from './egress-policy.js';

export const MODEL_EGRESS_DISABLED = 'MODEL_EGRESS_DISABLED';
export const MODEL_PROVIDER_API_KEY_MISSING = 'MODEL_PROVIDER_API_KEY_MISSING';
export const MODEL_EGRESS_AUDIT_UNAVAILABLE = 'MODEL_EGRESS_AUDIT_UNAVAILABLE';
export const MODEL_EGRESS_HTTP_ERROR = 'MODEL_EGRESS_HTTP_ERROR';
export const MODEL_EGRESS_REDIRECT_FORBIDDEN = 'MODEL_EGRESS_REDIRECT_FORBIDDEN';
export const MODEL_EGRESS_RESPONSE_TOO_LARGE = 'MODEL_EGRESS_RESPONSE_TOO_LARGE';
export const MODEL_PROVIDER_INVALID_JSON = 'MODEL_PROVIDER_INVALID_JSON';
export const MODEL_PROVIDER_INVALID_SSE = 'MODEL_PROVIDER_INVALID_SSE';

export interface ModelEgressOptions {
  enabled: boolean;
  proxyUrl: string | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
}

export interface ModelEgressAuditEntry {
  ownerId: string;
  modelConnectionId: string;
  agentRunId: string | null;
  host: string | null;
  port: number | null;
  decision: 'allowed' | 'blocked' | 'request_failed';
  reasonCode: string;
}

export interface ModelEgressAuditWriter {
  record(entry: ModelEgressAuditEntry): Promise<void>;
}

export class ModelEgressRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly providerErrorCode: string | null = null,
    readonly providerErrorMessage: string | null = null,
  ) {
    super(message);
    this.name = 'ModelEgressRequestError';
  }
}

export interface PinnedRequestOptions {
  pinnedIp: string;
  port: number;
  /** TLS SNI 与证书校验使用的域名；绝不能省略，否则 Node 会退化为按对端地址校验证书。 */
  servername: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  proxyUrl: string | null;
  ca?: string | Buffer;
}

export interface PinnedHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer>;
}

export interface PinnedRequester {
  request(options: PinnedRequestOptions): Promise<PinnedHttpResponse>;
}

/** 打开到目标（或代理）的 TCP 连接，超时或失败统一抛错。 */
function openTcpSocket(port: number, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('连接超时'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 经 CONNECT 代理建立到「钉死 IP」的隧道；与 Python 现状一致：代理只看到 IP。 */
function openConnectTunnel(proxyUrl: string, host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const proxyPort = proxy.port === '' ? 80 : Number(proxy.port);
    openTcpSocket(proxyPort, proxy.hostname, timeoutMs)
      .then((socket) => {
        let buffer = '';
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('latin1');
          if (!buffer.includes('\r\n\r\n')) {
            return;
          }
          socket.removeListener('data', onData);
          if (!/^HTTP\/1\.[01] 200/.test(buffer)) {
            socket.destroy();
            reject(new Error('CONNECT 代理拒绝建立隧道'));
            return;
          }
          resolve(socket);
        };
        socket.on('data', onData);
        socket.once('error', reject);
        const target = host.includes(':') ? '[' + host + ']' : host;
        socket.write('CONNECT ' + target + ':' + String(port) + ' HTTP/1.1\r\nHost: ' + target + ':' + String(port) + '\r\n\r\n');
      })
      .catch(reject);
  });
}

/** 建立已完成 TLS 握手、且按 servername 校验证书的 socket。 */
async function openPinnedTlsSocket(options: PinnedRequestOptions): Promise<TLSSocket> {
  const raw =
    options.proxyUrl === null
      ? await openTcpSocket(options.port, options.pinnedIp, options.connectTimeoutMs)
      : await openConnectTunnel(options.proxyUrl, options.pinnedIp, options.port, options.connectTimeoutMs);
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket: raw,
      servername: options.servername,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error('TLS 握手超时'));
    }, options.connectTimeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 默认传输层实现：直连或经 CONNECT 代理，均以钉死 IP 为连接目标、以 servername 做证书校验。 */
export function createNodePinnedRequester(): PinnedRequester {
  return {
    async request(options: PinnedRequestOptions): Promise<PinnedHttpResponse> {
      const tlsSocket = await openPinnedTlsSocket(options);
      return new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            method: 'POST',
            path: options.path,
            headers: options.headers,
            setHost: false,
            // 不使用 Agent：只有 agent 为空时 Node 才会采用 createConnection。
            // 传 agent:false 会新建默认 Agent 并忽略这里的已连接 TLS socket（会误连 host 默认值）。
            createConnection: () => tlsSocket,
          },
          (response: IncomingMessage) => {
            resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response });
          },
        );
        request.setTimeout(options.readTimeoutMs, () => {
          request.destroy(new Error('读取超时'));
        });
        request.once('error', reject);
        request.end(options.body);
      });
    },
  };
}

function decompressorFor(encoding: string): Transform | null {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

/** 按 content-encoding 解压响应体；与 Python 的 httpx 默认自动解压行为保持一致。 */
function prepareBody(response: PinnedHttpResponse): AsyncIterable<Buffer> {
  const rawEncoding = response.headers['content-encoding'];
  const encoding = (Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding ?? '').toLowerCase();
  const decompressor = decompressorFor(encoding);
  const source = Readable.from(response.body);
  if (decompressor === null) {
    return source;
  }
  const output = new PassThrough();
  void pipeline(source, decompressor, output).catch((error: unknown) => output.destroy(error as Error));
  return output;
}

/** 按“解压后字节”累计读取，超限即中断；上限必须作用于解压后的内容，否则 gzip 炸弹可绕过。 */
async function readBoundedBody(response: PinnedHttpResponse, maxBytes: number, errorCode: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of prepareBody(response)) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        throw new ModelEgressRequestError(errorCode, '模型响应体超过大小上限。', false);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ModelEgressRequestError) {
      throw error;
    }
    throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_JSON, '模型响应体解码失败。', false);
  }
  return Buffer.concat(chunks);
}

export interface ModelEgressCallInput {
  ownerId: string;
  modelConnectionId: string;
  agentRunId: string | null;
  baseUrl: string;
  apiKey: string;
  endpointSegments: readonly string[];
  payload: unknown;
  ca?: string | Buffer;
}

export class SafeModelEgressClient {
  private readonly policy: EgressEndpointPolicy;
  private readonly requester: PinnedRequester;

  constructor(
    private readonly options: ModelEgressOptions,
    private readonly auditWriter: ModelEgressAuditWriter,
    policy: EgressEndpointPolicy = new ModelEgressPolicy(),
    requester: PinnedRequester = createNodePinnedRequester(),
  ) {
    this.policy = policy;
    this.requester = requester;
  }

  /** 发起非流式 JSON 调用，返回 Provider 原始响应（不做业务校验）。 */
  async postOpenAiCompatibleJson(input: ModelEgressCallInput): Promise<{ statusCode: number; payload: unknown }> {
    const response = await this.post(input, 'application/json');
    this.ensureNotRedirect(response.statusCode);
    this.ensureNotTooLargeByHeader(response);
    const body = await readBoundedBody(response, this.options.maxResponseBytes, MODEL_EGRESS_RESPONSE_TOO_LARGE);
    this.ensureProviderSuccess(response.statusCode, body);
    try {
      return { statusCode: response.statusCode, payload: JSON.parse(body.toString('utf8')) };
    } catch {
      throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_JSON, '模型响应不是合法 JSON。', false);
    }
  }

  /**
   * 发起流式请求并返回可逐项消费的 data-only SSE 事件流。
   * 调用方必须把 events 迭代到结束，才能完成响应体上限、非空事件与 [DONE] 完整性校验。
   */
  async postOpenAiCompatibleSse(
    input: ModelEgressCallInput,
  ): Promise<{ statusCode: number; events: AsyncIterable<unknown> }> {
    const response = await this.post(input, 'text/event-stream');
    this.ensureNotRedirect(response.statusCode);
    this.ensureNotTooLargeByHeader(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      // 非 2xx 必须先分类为可重试/不可重试，不能因为响应体不是 SSE 而误报结构错误。
      const errorBody = await readBoundedBody(response, this.options.maxResponseBytes, MODEL_EGRESS_RESPONSE_TOO_LARGE);
      this.ensureProviderSuccess(response.statusCode, errorBody);
    }
    const contentType = String(response.headers['content-type'] ?? '');
    if (!contentType.startsWith('text/event-stream')) {
      throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_SSE, '流式响应缺少 text/event-stream。', false);
    }
    return {
      statusCode: response.statusCode,
      events: readSse(response, this.options.maxResponseBytes),
    };
  }

  private async post(input: ModelEgressCallInput, accept: string): Promise<PinnedHttpResponse> {
    if (!this.options.enabled) {
      throw new ModelEgressRequestError(MODEL_EGRESS_DISABLED, '模型受控出网未启用。', false);
    }
    if (input.apiKey.trim().length === 0) {
      throw new ModelEgressRequestError(MODEL_PROVIDER_API_KEY_MISSING, '模型 API Key 为空。', false);
    }
    let endpoint: ResolvedEndpoint;
    try {
      endpoint = await this.policy.resolveEndpoint(input.baseUrl);
    } catch (error) {
      if (error instanceof ModelEgressPolicyError) {
        await this.recordBestEffort(input, 'blocked', error.code, null, null);
        throw new ModelEgressRequestError(error.code, error.message, false);
      }
      throw error;
    }
    const pinnedUrl = ModelEgressPolicy.buildPinnedRequestUrl(endpoint, input.endpointSegments);
    await this.recordOrBlock(input, endpoint);
    const body = Buffer.from(JSON.stringify(input.payload), 'utf8');
    try {
      return await this.requester.request({
        pinnedIp: endpoint.pinnedIp,
        port: endpoint.port,
        servername: endpoint.hostname,
        path: new URL(pinnedUrl).pathname,
        headers: {
          Accept: accept,
          'Content-Type': 'application/json',
          // Host 必须是原域名：Provider 常按 Host 路由，且 fetch 无法设置该头（实测结论 T5）。
          Host: endpoint.hostname,
          Authorization: 'Bearer ' + input.apiKey,
          'User-Agent': 'LearnCraft-Agent/0.1',
          'Content-Length': String(body.byteLength),
        },
        body,
        connectTimeoutMs: this.options.connectTimeoutMs,
        readTimeoutMs: this.options.readTimeoutMs,
        proxyUrl: this.options.proxyUrl,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
      });
    } catch (error) {
      await this.recordBestEffort(input, 'request_failed', MODEL_EGRESS_HTTP_ERROR, endpoint.hostname, endpoint.port);
      const reason = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : null;
      throw new ModelEgressRequestError(
        MODEL_EGRESS_HTTP_ERROR,
        reason === null ? '模型出网请求失败。' : '模型出网请求失败（' + reason + '）。',
        true,
        reason,
        null,
      );
    }
  }

  /** 发请求前写 allowed 审计；写入失败即拒绝调用（fail-closed）。 */
  private async recordOrBlock(input: ModelEgressCallInput, endpoint: ResolvedEndpoint): Promise<void> {
    try {
      await this.auditWriter.record({
        ownerId: input.ownerId,
        modelConnectionId: input.modelConnectionId,
        agentRunId: input.agentRunId,
        host: endpoint.hostname,
        port: endpoint.port,
        decision: 'allowed',
        reasonCode: 'MODEL_EGRESS_POLICY_ALLOWED',
      });
    } catch {
      throw new ModelEgressRequestError(MODEL_EGRESS_AUDIT_UNAVAILABLE, '模型出网审计不可用。', true);
    }
  }

  private async recordBestEffort(
    input: ModelEgressCallInput,
    decision: ModelEgressAuditEntry['decision'],
    reasonCode: string,
    host: string | null,
    port: number | null,
  ): Promise<void> {
    try {
      await this.auditWriter.record({
        ownerId: input.ownerId,
        modelConnectionId: input.modelConnectionId,
        agentRunId: input.agentRunId,
        host,
        port,
        decision,
        reasonCode,
      });
    } catch {
      // 审计写入失败不影响错误分类；出网本身已被拒绝。
    }
  }

  private ensureNotRedirect(statusCode: number): void {
    if (statusCode >= 300 && statusCode < 400) {
      throw new ModelEgressRequestError(MODEL_EGRESS_REDIRECT_FORBIDDEN, '模型 Provider 返回了重定向。', false);
    }
  }

  private ensureNotTooLargeByHeader(response: PinnedHttpResponse): void {
    const rawLength = response.headers['content-length'];
    const value = Array.isArray(rawLength) ? rawLength[0] : rawLength;
    if (value === undefined || !/^\d+$/.test(value)) {
      return;
    }
    if (Number(value) > this.options.maxResponseBytes) {
      throw new ModelEgressRequestError(MODEL_EGRESS_RESPONSE_TOO_LARGE, '模型响应体超过大小上限。', false);
    }
  }

  private ensureProviderSuccess(statusCode: number, body: Buffer): void {
    if (statusCode >= 200 && statusCode < 300) {
      return;
    }
    const retryable = statusCode === 429 || statusCode >= 500;
    const detail = extractProviderError(body);
    throw new ModelEgressRequestError(
      'MODEL_PROVIDER_HTTP_' + String(statusCode),
      '模型 Provider 返回非成功状态。',
      retryable,
      detail.code,
      detail.message,
    );
  }
}

/** 从 Provider 错误体中提取脱敏后的错误码与摘要，不含密钥与正文。 */
function extractProviderError(body: Buffer): { code: string | null; message: string | null } {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return { code: null, message: null };
    }
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) {
      return { code: null, message: null };
    }
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    return {
      code: typeof code === 'string' ? code.slice(0, 128) : null,
      message: typeof message === 'string' ? message.replace(/\s+/g, ' ').slice(0, 240) : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

/**
 * 逐项解析 data-only SSE：忽略注释行与非 data 行，不保存完整事件数组，并要求以 [DONE] 结束。
 */
async function* readSse(
  response: PinnedHttpResponse,
  maxBytes: number,
): AsyncGenerator<unknown, void, void> {
  let buffer = '';
  let received = 0;
  let eventCount = 0;
  let sawDone = false;
  for await (const chunk of prepareBody(response)) {
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw new ModelEgressRequestError(MODEL_EGRESS_RESPONSE_TOO_LARGE, '模型流式响应超过大小上限。', false);
    }
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0 && !line.startsWith(':')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            sawDone = true;
          } else if (data.length > 0) {
            try {
              const event: unknown = JSON.parse(data);
              eventCount += 1;
              yield event;
            } catch {
              throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_SSE, '模型流式响应包含非法 JSON。', false);
            }
          }
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_SSE, '模型流式响应存在残缺尾部。', false);
  }
  if (eventCount === 0) {
    throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_SSE, '模型流式响应没有事件。', false);
  }
  if (!sawDone) {
    throw new ModelEgressRequestError(MODEL_PROVIDER_INVALID_SSE, '模型流式响应缺少结束标记。', true);
  }
}
