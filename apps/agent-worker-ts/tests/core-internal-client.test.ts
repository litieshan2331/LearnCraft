/**
 * Web 内部接口 ACL 客户端的单元测试。
 *
 * 覆盖：请求头与鉴权、缺失密钥时提前失败、404/401/403/5xx/其他非 2xx 的错误码与可重试性、
 * 响应契约校验（多一个键即判定为契约不符）以及网络异常归类。
 */
import { describe, expect, it } from 'vitest';

import {
  CoreInternalClient,
  INTERNAL_SERVICE_SECRET_HEADER,
  type CoreInternalClientError,
} from '../src/acl/core-internal-client.js';

const SECRET = 'internal-secret-for-test';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  responder: (captured: Captured) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = { url: String(url), init: init ?? {} };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_ENVELOPE = {
  owner_id: '11111111-2222-4333-8444-555555555555',
  connection_id: '66666666-7777-4888-8999-000000000000',
  base_url: 'https://api.example.com',
  model_id: 'deepseek-flash',
  credential: {
    ciphertext_base64: 'AAAA',
    iv_base64: 'BBBB',
    auth_tag_base64: 'CCCC',
    encryption_key_version: 'local-v1',
  },
};

function client(fetchImpl: typeof fetch, secret: string | null = SECRET): CoreInternalClient {
  return new CoreInternalClient({
    baseUrl: 'http://127.0.0.1:3000/internal/v1/',
    internalServiceSecret: secret,
    fetchImpl,
  });
}

async function expectCode(promise: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, retryable } satisfies Partial<CoreInternalClientError>);
}

describe('CoreInternalClient', () => {
  it('发送内部服务密钥与标准请求头，并返回校验后的信封', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, VALID_ENVELOPE));
    const envelope = await client(fetchImpl).getDefaultModelConnection('run-1');

    expect(envelope.model_id).toBe('deepseek-flash');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/internal/v1/agent-runs/run-1/default-model-connection');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[INTERNAL_SERVICE_SECRET_HEADER]).toBe(SECRET);
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toBe('LearnCraft-Agent/0.1');
    // GET 不带 Content-Type。
    expect(headers['Content-Type']).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('未配置服务密钥时在发请求之前失败', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, VALID_ENVELOPE));
    await expectCode(client(fetchImpl, null).getDefaultModelConnection('run-1'), 'INTERNAL_SERVICE_SECRET_MISSING', false);
    expect(calls).toHaveLength(0);
  });

  it('按状态码分类错误：404 / 401 / 5xx / 其他非 2xx', async () => {
    await expectCode(
      client(fakeFetch(() => jsonResponse(404, { error: 'DEFAULT_MODEL_CONNECTION_NOT_FOUND' })).fetchImpl)
        .getDefaultModelConnection('run-1'),
      'DEFAULT_MODEL_CONNECTION_NOT_FOUND',
      false,
    );
    await expectCode(
      client(fakeFetch(() => jsonResponse(401, { error: 'UNAUTHORIZED' })).fetchImpl).getDefaultModelConnection('run-1'),
      'CORE_INTERNAL_AUTH_FAILED',
      false,
    );
    await expectCode(
      client(fakeFetch(() => jsonResponse(500, { error: 'INTERNAL_ERROR' })).fetchImpl).getDefaultModelConnection('run-1'),
      'CORE_INTERNAL_UNAVAILABLE',
      true,
    );
    await expectCode(
      client(fakeFetch(() => jsonResponse(422, { error: 'VALIDATION_ERROR' })).fetchImpl).persistAssessment('run-1', {}),
      'ASSESSMENT_PERSISTENCE_REJECTED',
      false,
    );
  });

  it('网络异常归类为可重试的内部服务不可用', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expectCode(client(fetchImpl).getDefaultModelConnection('run-1'), 'CORE_INTERNAL_UNAVAILABLE', true);
  });

  it('响应多出未知字段时判定为契约不符', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { ...VALID_ENVELOPE, unexpected: true }));
    await expectCode(client(fetchImpl).getDefaultModelConnection('run-1'), 'CORE_INTERNAL_RESPONSE_INVALID', false);
  });

  it('持久化题集时发送 snake_case 请求体与 JSON 内容类型', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(200, { assessment_id: '11111111-2222-4333-8444-555555555555', status: 'ready', question_count: 10 }),
    );
    const result = await client(fetchImpl).persistAssessment('run-9', { kind: 'diagnostic', question_count: 10 });

    expect(result).toEqual({
      assessment_id: '11111111-2222-4333-8444-555555555555',
      status: 'ready',
      question_count: 10,
    });
    expect(calls[0]?.url).toContain('/agent-runs/run-9/assessment-result');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: 'diagnostic', question_count: 10 });
  });

  it('把 AbortSignal 超时传给 fetch', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, VALID_ENVELOPE));
    await client(fetchImpl).getDefaultModelConnection('run-1');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});
