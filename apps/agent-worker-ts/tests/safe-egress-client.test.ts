/**
 * 受控出网客户端的单元测试（对应 Python 的 test_model_egress_policy.py 与网关测试中的安全断言）。
 *
 * 覆盖：钉死 IP + SNI + Host 头的请求构造、allowed 审计先写且写失败即拒绝（fail-closed）、
 * 重定向与超限拒绝（含 gzip 炸弹）、Provider 错误分类与可重试性、SSE 结构与结束标记校验。
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';

import {
  MODEL_EGRESS_AUDIT_UNAVAILABLE,
  MODEL_EGRESS_DISABLED,
  MODEL_EGRESS_HTTP_ERROR,
  MODEL_EGRESS_REDIRECT_FORBIDDEN,
  MODEL_EGRESS_RESPONSE_TOO_LARGE,
  MODEL_PROVIDER_API_KEY_MISSING,
  MODEL_PROVIDER_INVALID_JSON,
  MODEL_PROVIDER_INVALID_SSE,
  SafeModelEgressClient,
  type ModelEgressAuditEntry,
  type ModelEgressAuditWriter,
  type ModelEgressOptions,
  type PinnedHttpResponse,
  type PinnedRequestOptions,
  type PinnedRequester,
} from '../src/infrastructure/llm/safe-egress-client.js';
import {
  MODEL_EGRESS_PRIVATE_IP_FORBIDDEN,
  ModelEgressPolicyError,
  type EgressEndpointPolicy,
  type ResolvedEndpoint,
} from '../src/infrastructure/llm/egress-policy.js';

const OPTIONS: ModelEgressOptions = {
  enabled: true,
  proxyUrl: null,
  connectTimeoutMs: 1000,
  readTimeoutMs: 1000,
  maxResponseBytes: 1024,
};

const ENDPOINT: ResolvedEndpoint = {
  baseUrl: 'https://api.example.com/v1',
  hostname: 'api.example.com',
  port: 443,
  pinnedIp: '8.8.8.8',
};

function stubPolicy(endpoint: ResolvedEndpoint = ENDPOINT): EgressEndpointPolicy {
  return { resolveEndpoint: async () => endpoint };
}

class RecordingAuditWriter implements ModelEgressAuditWriter {
  readonly entries: ModelEgressAuditEntry[] = [];

  async record(entry: ModelEgressAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function failingResponse(chunks: Buffer[], headers: IncomingHttpHeaders = {}): PinnedHttpResponse {
  return {
    statusCode: 200,
    headers,
    body: (async function* generate() {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

class FakeRequester implements PinnedRequester {
  readonly calls: PinnedRequestOptions[] = [];

  constructor(private readonly respond: (options: PinnedRequestOptions) => PinnedHttpResponse) {}

  async request(options: PinnedRequestOptions): Promise<PinnedHttpResponse> {
    this.calls.push(options);
    return this.respond(options);
  }
}

function call(client: SafeModelEgressClient, endpointSegments: readonly string[] = ['chat', 'completions']) {
  return client.postOpenAiCompatibleJson({
    ownerId: 'owner-1',
    modelConnectionId: 'connection-1',
    agentRunId: 'run-1',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret-key',
    endpointSegments,
    payload: { model: 'demo-model', stream: true },
  });
}

describe('SafeModelEgressClient 请求构造', () => {
  it('连接钉死 IP，并以原域名作为 servername 与 Host 头', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.from('{"ok":true}')], { 'content-type': 'application/json' }));
    const audit = new RecordingAuditWriter();
    const client = new SafeModelEgressClient(OPTIONS, audit, stubPolicy(), requester);

    await call(client);

    const options = requester.calls[0];
    expect(options?.pinnedIp).toBe('8.8.8.8');
    expect(options?.servername).toBe('api.example.com');
    expect(options?.headers.Host).toBe('api.example.com');
    expect(options?.headers.Authorization).toBe('Bearer sk-secret-key');
    expect(options?.path).toBe('/v1/chat/completions');
    expect(audit.entries).toEqual([
      {
        ownerId: 'owner-1',
        modelConnectionId: 'connection-1',
        agentRunId: 'run-1',
        host: 'api.example.com',
        port: 443,
        decision: 'allowed',
        reasonCode: 'MODEL_EGRESS_POLICY_ALLOWED',
      },
    ]);
  });

  it('审计写入失败时拒绝出网（fail-closed），且不发起请求', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.from('{}')]));
    const failingAudit: ModelEgressAuditWriter = {
      record: async () => {
        throw new Error('审计库不可用');
      },
    };
    const client = new SafeModelEgressClient(OPTIONS, failingAudit, stubPolicy(), requester);

    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_AUDIT_UNAVAILABLE, retryable: true });
    expect(requester.calls).toHaveLength(0);
  });

  it('策略拒绝时写 blocked 审计并归类为不可重试', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.from('{}')]));
    const audit = new RecordingAuditWriter();
    const rejectingPolicy: EgressEndpointPolicy = {
      resolveEndpoint: async () => {
        throw new ModelEgressPolicyError(MODEL_EGRESS_PRIVATE_IP_FORBIDDEN, '解析到私网地址');
      },
    };
    const client = new SafeModelEgressClient(OPTIONS, audit, rejectingPolicy, requester);

    await expect(call(client)).rejects.toMatchObject({ retryable: false });
    expect(requester.calls).toHaveLength(0);
  });

  it('未启用出网或 Key 为空时直接拒绝', async () => {
    const client = new SafeModelEgressClient({ ...OPTIONS, enabled: false }, new RecordingAuditWriter(), stubPolicy(), new FakeRequester(() => failingResponse([])));
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_DISABLED, retryable: false });

    const noKeyClient = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), new FakeRequester(() => failingResponse([])));
    await expect(
      noKeyClient.postOpenAiCompatibleJson({
        ownerId: 'owner-1',
        modelConnectionId: 'connection-1',
        agentRunId: null,
        baseUrl: 'https://api.example.com/v1',
        apiKey: '   ',
        endpointSegments: ['chat', 'completions'],
        payload: {},
      }),
    ).rejects.toMatchObject({ code: MODEL_PROVIDER_API_KEY_MISSING, retryable: false });
  });
});

describe('SafeModelEgressClient 响应处理', () => {
  it('拒绝重定向', async () => {
    const requester = new FakeRequester(() => ({ ...failingResponse([]), statusCode: 302 }));
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_REDIRECT_FORBIDDEN, retryable: false });
  });

  it('按 content-length 预检拒绝超大响应', async () => {
    const requester = new FakeRequester(() =>
      failingResponse([Buffer.from('{}')], { 'content-length': '999999' }),
    );
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_RESPONSE_TOO_LARGE, retryable: false });
  });

  it('流式累计超过上限时拒绝', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.alloc(600, 65), Buffer.alloc(600, 66)]));
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_RESPONSE_TOO_LARGE });
  });

  it('gzip 炸弹必须按解压后字节拒绝', async () => {
    const bomb = gzipSync(Buffer.alloc(200_000, 65));
    expect(bomb.byteLength).toBeLessThan(1024);
    const requester = new FakeRequester(() =>
      failingResponse([bomb], { 'content-encoding': 'gzip', 'content-type': 'application/json' }),
    );
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_RESPONSE_TOO_LARGE });
  });

  it('429 可重试、400 不可重试，并保留脱敏的 Provider 错误信息', async () => {
    const body = Buffer.from(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }));
    const tooMany = new FakeRequester(() => ({ ...failingResponse([body]), statusCode: 429 }));
    const client429 = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), tooMany);
    await expect(call(client429)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_HTTP_429',
      retryable: true,
      providerErrorCode: 'rate_limited',
      providerErrorMessage: 'slow down',
    });

    const badRequest = new FakeRequester(() => ({ ...failingResponse([body]), statusCode: 400 }));
    const client400 = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), badRequest);
    await expect(call(client400)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_400', retryable: false });
  });

  it('非法 JSON 归类为不可重试', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.from('not-json')], { 'content-type': 'application/json' }));
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_PROVIDER_INVALID_JSON, retryable: false });
  });

  it('传输层异常归类为可重试的出网错误', async () => {
    const requester: PinnedRequester = {
      request: async () => {
        throw new Error('socket hang up');
      },
    };
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(call(client)).rejects.toMatchObject({ code: MODEL_EGRESS_HTTP_ERROR, retryable: true });
  });
});

describe('SafeModelEgressClient SSE', () => {
  const sseHeaders: IncomingHttpHeaders = { 'content-type': 'text/event-stream' };

  function sseClient(chunks: Buffer[]): SafeModelEgressClient {
    const requester = new FakeRequester(() => failingResponse(chunks, sseHeaders));
    return new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
  }

  function callSse(client: SafeModelEgressClient) {
    return client.postOpenAiCompatibleSse({
      ownerId: 'owner-1',
      modelConnectionId: 'connection-1',
      agentRunId: 'run-1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret-key',
      endpointSegments: ['chat', 'completions'],
      payload: { model: 'demo-model', stream: true },
    });
  }

  it('解析 data-only 事件并要求 [DONE] 结束', async () => {
    const client = sseClient([
      Buffer.from(': keep-alive\n'),
      Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
      Buffer.from('data: [DONE]\n\n'),
    ]);
    const result = await callSse(client);
    expect(result.events).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
  });

  it('缺少 [DONE] 时归类为可重试', async () => {
    const client = sseClient([Buffer.from('data: {"choices":[]}\n\n')]);
    await expect(callSse(client)).rejects.toMatchObject({ code: MODEL_PROVIDER_INVALID_SSE, retryable: true });
  });

  it('没有事件时归类为不可重试', async () => {
    const client = sseClient([Buffer.from('data: [DONE]\n\n')]);
    await expect(callSse(client)).rejects.toMatchObject({ code: MODEL_PROVIDER_INVALID_SSE, retryable: false });
  });

  it('Content-Type 不是 text/event-stream 时拒绝', async () => {
    const requester = new FakeRequester(() => failingResponse([Buffer.from('{}')], { 'content-type': 'application/json' }));
    const client = new SafeModelEgressClient(OPTIONS, new RecordingAuditWriter(), stubPolicy(), requester);
    await expect(callSse(client)).rejects.toMatchObject({ code: MODEL_PROVIDER_INVALID_SSE, retryable: false });
  });
});
