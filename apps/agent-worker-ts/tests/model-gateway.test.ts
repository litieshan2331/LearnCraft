/**
 * OpenAI-compatible 模型网关的单元测试（使用假出网端口，不发真实请求）。
 *
 * 覆盖：载荷构造（stream/stream_options、工具、response_format 的 json 提示、DeepSeek thinking）、
 * SSE 聚合（正文、用量、工具调用按 index 合并、截断与空响应）、错误分类与重试退避。
 */
import { describe, expect, it } from 'vitest';

import {
  ModelGatewayError,
  OpenAiCompatibleModelGateway,
  parseStreamCompletion,
  type ModelCompletionRequest,
  type ModelEgressPort,
} from '../src/infrastructure/llm/model-gateway.js';
import { ModelEgressRequestError, type ModelEgressCallInput } from '../src/infrastructure/llm/safe-egress-client.js';
import { ModelRateLimitError, type ModelRateLimiter } from '../src/infrastructure/redis/model-rate-limiter.js';
import type { FallbackTokenBudget } from '../src/infrastructure/redis/fallback-budget.js';
import type { AgentTraceEventInput, TraceWriter } from '../src/application/services/trace-writer.js';

const CONNECTION = {
  ownerId: '11111111-2222-3333-4444-555555555555',
  connectionId: '66666666-7777-8888-9999-000000000000',
  baseUrl: 'https://api.example.com',
  modelId: 'deepseek-flash',
  apiKey: 'sk-test',
};

function request(overrides: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  return {
    agentRunId: 'run-1',
    connection: CONNECTION,
    messages: [{ role: 'user', content: '请给出 json' }],
    ...overrides,
  };
}

class FakeEgress implements ModelEgressPort {
  readonly calls: ModelEgressCallInput[] = [];

  constructor(private readonly responder: (input: ModelEgressCallInput) => unknown[] | Error) {}

  async postOpenAiCompatibleSse(
    input: ModelEgressCallInput,
  ): Promise<{ statusCode: number; events: AsyncIterable<unknown> }> {
    this.calls.push(input);
    const result = this.responder(input);
    if (result instanceof Error) {
      throw result;
    }
    return {
      statusCode: 200,
      events: (async function* streamEvents() {
        for (const item of result) {
          yield item;
        }
      })(),
    };
  }
}

class FakeTraceWriter implements TraceWriter {
  readonly events: AgentTraceEventInput[] = [];

  async append(event: AgentTraceEventInput): Promise<void> {
    this.events.push(event);
  }
}

function event(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { choices: [{ index: 0, delta }], ...extra };
}

describe('思考增量转发', () => {
  it('按到达顺序回调 reasoning_content，且聚合结果不受影响', async () => {
    const gateway = new OpenAiCompatibleModelGateway(
      new FakeEgress(() => [
        event({ reasoning_content: '第一步：' }),
        event({ reasoning_content: '第二步' }),
        event({ content: '{"ok":true}' }),
      ]),
      0,
    );
    const chunks: string[] = [];

    const response = await gateway.complete(request({ onReasoningDelta: (text) => chunks.push(text) }));

    expect(chunks).toEqual(['第一步：', '第二步']);
    expect(response.message.reasoningContent).toBe('第一步：第二步');
  });

  it('没有 reasoning_content 时不回调，且回调抛错不影响本次调用', async () => {
    const gateway = new OpenAiCompatibleModelGateway(
      new FakeEgress(() => [event({ content: '{"ok":true}' })]),
      0,
    );
    let called = 0;

    const response = await gateway.complete(
      request({ onReasoningDelta: () => { called += 1; } }),
    );

    expect(called).toBe(0);
    expect(response.message.content).toBe('{"ok":true}');
  });
});

describe('载荷构造', () => {
  const gateway = new OpenAiCompatibleModelGateway(new FakeEgress(() => []), 0);

  it('始终使用 stream=true 且要求用量', () => {
    const payload = gateway.buildPayload(request());
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.model).toBe('deepseek-flash');
  });

  it('response_format=json_object 时补全 json 提示并设置响应格式', () => {
    const withJson = gateway.buildPayload(
      request({ responseFormat: 'json_object', messages: [{ role: 'user', content: '帮我出题' }] }),
    );
    expect(withJson.response_format).toEqual({ type: 'json_object' });
    const messages = withJson.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]?.content)).toContain('json');

    const alreadyJson = gateway.buildPayload(
      request({ responseFormat: 'json_object', messages: [{ role: 'user', content: '返回 json' }] }),
    );
    const jsonMessages = alreadyJson.messages as Array<Record<string, unknown>>;
    expect(jsonMessages[0]?.content).toBe('返回 json');
  });

  it('仅在提供工具时带 tools 与 tool_choice', () => {
    const withoutTools = gateway.buildPayload(request());
    expect(withoutTools.tools).toBeUndefined();

    const withTools = gateway.buildPayload(
      request({
        tools: [{ name: 'tavily_search', description: '搜索', parameters: { type: 'object' } }],
      }),
    );
    expect(withTools.tool_choice).toBe('auto');
    expect((withTools.tools as unknown[])[0]).toMatchObject({
      type: 'function',
      function: { name: 'tavily_search' },
    });
  });

  it('只有 deepseek-v4 系列才带 thinking 参数', () => {
    expect(gateway.buildPayload(request()).thinking).toBeUndefined();
    const v4 = gateway.buildPayload({ ...request(), connection: { ...CONNECTION, modelId: 'DeepSeek-V4-Chat' } });
    expect(v4.thinking).toEqual({ type: 'enabled' });
  });
});

describe('SSE 聚合', () => {
  it('拼接正文与用量', () => {
    const parsed = parseStreamCompletion([
      event({ content: '你' }),
      event({ content: '好' }),
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 11 } },
    ]);
    expect(parsed.message.content).toBe('你好');
    expect(parsed.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
  });

  it('按 index 合并工具调用参数分片', () => {
    const parsed = parseStreamCompletion([
      event({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'tavily_search', arguments: '{"qu' } }] }),
      event({ tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] }),
    ]);
    expect(parsed.message.toolCalls).toEqual([
      { id: 'call-1', name: 'tavily_search', argumentsJson: '{"query":"x"}' },
    ]);
  });

  it('finish_reason=length 视为截断且不可重试', () => {
    expect(() => parseStreamCompletion([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }])).toThrow(
      expect.objectContaining({ code: 'MODEL_PROVIDER_RESPONSE_TRUNCATED', retryable: false }),
    );
  });

  it('既无正文也无工具调用时报响应非法', () => {
    expect(() => parseStreamCompletion([event({})])).toThrow(
      expect.objectContaining({ code: 'MODEL_PROVIDER_RESPONSE_INVALID' }),
    );
  });
});

describe('错误分类与重试', () => {
  it('主模型重试耗尽后切换服务端备用模型并按实际 Token 记账', async () => {
    const fallbackConnection = { ...CONNECTION, connectionId: 'system-fallback', modelId: 'fallback-model', apiKey: 'server-only-key' };
    const egress = new FakeEgress((input) => {
      if (input.modelConnectionId !== fallbackConnection.connectionId) {
        return new ModelEgressRequestError('MODEL_PROVIDER_HTTP_503', '主模型不可用', true);
      }
      return [event({ content: '备用成功' }), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }];
    });
    const recorded: number[] = [];
    const budget: FallbackTokenBudget = {
      allow: async () => undefined,
      record: async (tokens) => { recorded.push(tokens); },
    };
    const gateway = new OpenAiCompatibleModelGateway(
      egress,
      1,
      async () => undefined,
      null,
      fallbackConnection,
      budget,
    );

    const response = await gateway.complete(request());

    expect(response.message.content).toBe('备用成功');
    expect(egress.calls.map((call) => call.modelConnectionId)).toEqual([
      CONNECTION.connectionId,
      CONNECTION.connectionId,
      fallbackConnection.connectionId,
    ]);
    expect(recorded).toEqual([20]);
    expect(egress.calls[2]?.apiKey).toBe('server-only-key');
  });

  it('主模型失败后记录回退事件和备用模型完成事件', async () => {
    const fallbackConnection = { ...CONNECTION, connectionId: 'system-fallback', modelId: 'fallback-model', apiKey: 'server-only-key' };
    const trace = new FakeTraceWriter();
    const egress = new FakeEgress((input) => input.modelConnectionId === fallbackConnection.connectionId
      ? [event({ content: '备用成功' })]
      : new ModelEgressRequestError('MODEL_PROVIDER_HTTP_503', '主模型不可用', true));
    const gateway = new OpenAiCompatibleModelGateway(
      egress,
      0,
      async () => undefined,
      null,
      fallbackConnection,
      null,
      trace,
    );

    await gateway.complete(request());

    expect(trace.events.map((item) => item.eventType)).toEqual([
      'llm.request.started',
      'llm.attempt.failed',
      'llm.fallback',
      'llm.request.started',
      'llm.attempt.completed',
    ]);
    expect(trace.events[2]?.payload).toMatchObject({
      fromModel: CONNECTION.modelId,
      toModel: fallbackConnection.modelId,
      reasonCode: 'MODEL_PROVIDER_HTTP_503',
      blocked: false,
    });
    expect(JSON.stringify(trace.events[2]?.payload)).not.toContain(fallbackConnection.apiKey);
  });

  it('记录最终 Provider 载荷、正文、Thinking、用量和时间，且不保存 API Key', async () => {
    const trace = new FakeTraceWriter();
    const gateway = new OpenAiCompatibleModelGateway(
      new FakeEgress(() => [
        event({ reasoning_content: '思考' }),
        event({ content: '答案' }),
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } },
      ]),
      0,
      undefined,
      null,
      null,
      null,
      trace,
    );

    await gateway.complete(request({
      turnNo: 2,
      connection: { ...CONNECTION, modelId: 'deepseek-v4-chat' },
      tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
      thinkingMode: 'enabled',
      responseFormat: 'json_object',
    }));

    const started = trace.events.find((item) => item.eventType === 'llm.request.started');
    expect(started).toMatchObject({ turnNo: 2, attemptNo: 1 });
    expect(started?.payload).toMatchObject({
      route: 'primary',
      model: 'deepseek-v4-chat',
      payload: {
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: 'json_object' },
        thinking: { type: 'enabled' },
      },
    });
    expect(JSON.stringify(started?.payload)).not.toContain(CONNECTION.apiKey);

    const completed = trace.events.find((item) => item.eventType === 'llm.attempt.completed');
    expect(completed?.startedAt).toBeInstanceOf(Date);
    expect(completed?.finishedAt).toBeInstanceOf(Date);
    expect(completed).toMatchObject({ inputTokens: 3, outputTokens: 5 });
    expect(completed?.payload).toMatchObject({
      response: { content: '答案', reasoningContent: '思考' },
      finishReason: null,
    });
  });

  it('记录失败和重试事件', async () => {
    const trace = new FakeTraceWriter();
    let calls = 0;
    const gateway = new OpenAiCompatibleModelGateway(
      new FakeEgress(() => {
        calls += 1;
        return calls === 1
          ? new ModelEgressRequestError('MODEL_PROVIDER_HTTP_429', '限流', true)
          : [event({ content: 'ok' })];
      }),
      1,
      async () => undefined,
      null,
      null,
      null,
      trace,
    );

    await gateway.complete(request());

    expect(trace.events.map((item) => item.eventType)).toEqual([
      'llm.request.started',
      'llm.attempt.failed',
      'llm.retry',
      'llm.request.started',
      'llm.attempt.completed',
    ]);
    expect(trace.events[1]).toMatchObject({ attemptNo: 1, payload: { errorCode: 'MODEL_PROVIDER_HTTP_429', retryable: true } });
    expect(trace.events[2]).toMatchObject({ payload: { failedAttempt: 1, nextAttempt: 2, delayMs: 500 } });
  });

  it('可重试错误按退避重试后成功', async () => {
    let attempt = 0;
    const egress = new FakeEgress(() => {
      attempt += 1;
      if (attempt === 1) {
        return new ModelEgressRequestError('MODEL_PROVIDER_HTTP_429', '限流', true);
      }
      return [event({ content: '{}' })];
    });
    const delays: number[] = [];
    const gateway = new OpenAiCompatibleModelGateway(egress, 3, async (ms) => void delays.push(ms));

    const response = await gateway.complete(request());

    expect(response.message.content).toBe('{}');
    expect(egress.calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });

  it('流消费期间出现可重试错误时丢弃本次局部聚合并重新请求', async () => {
    let attempt = 0;
    const egress: ModelEgressPort = {
      postOpenAiCompatibleSse: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        return {
          statusCode: 200,
          events: (async function* streamEvents() {
            yield event({ content: currentAttempt === 1 ? '失败尝试' : '成功' });
            if (currentAttempt === 1) {
              throw new ModelEgressRequestError('MODEL_PROVIDER_INVALID_SSE', '缺少结束标记', true);
            }
          })(),
        };
      },
    };
    const delays: number[] = [];
    const gateway = new OpenAiCompatibleModelGateway(egress, 2, async (ms) => void delays.push(ms));

    const response = await gateway.complete(request());

    expect(response.message.content).toBe('成功');
    expect(attempt).toBe(2);
    expect(delays).toEqual([500]);
  });

  it('不可重试错误立即上抛且不重试', async () => {
    const egress = new FakeEgress(() => new ModelEgressRequestError('MODEL_EGRESS_REDIRECT_FORBIDDEN', '重定向', false));
    const gateway = new OpenAiCompatibleModelGateway(egress, 3, async () => {});

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: 'MODEL_EGRESS_REDIRECT_FORBIDDEN',
      retryable: false,
    });
    expect(egress.calls).toHaveLength(1);
  });

  it('带工具时 Provider 拒绝请求归类为工具请求被拒', async () => {
    const egress = new FakeEgress(() => new ModelEgressRequestError('MODEL_PROVIDER_HTTP_400', 'bad request', false));
    const gateway = new OpenAiCompatibleModelGateway(egress, 0, async () => {});

    await expect(
      gateway.complete(request({ tools: [{ name: 'tavily_search', description: '搜索', parameters: {} }] })),
    ).rejects.toMatchObject({ code: 'MODEL_TOOL_CALL_REQUEST_REJECTED', retryable: false });
  });

  it('网关错误类型可被上层识别', () => {
    expect(new ModelGatewayError('X', 'y', false, ['a'])).toBeInstanceOf(Error);
  });
});


describe('模型限流接入', () => {
  it('每次 Provider 尝试前获取租约，结束后释放租约', async () => {
    const calls: string[] = [];
    const limiter: ModelRateLimiter = {
      acquire: async () => {
        calls.push('acquire');
        return {
          release: async () => {
            calls.push('release');
          },
        };
      },
    };
    const gateway = new OpenAiCompatibleModelGateway(
      new FakeEgress(() => [event({ content: '{}' })]),
      0,
      undefined,
      limiter,
    );

    await gateway.complete(request());

    expect(calls).toEqual(['acquire', 'release']);
  });

  it('限流拒绝转换为可重试的网关错误且不请求 Provider', async () => {
    let providerCalls = 0;
    const limiter: ModelRateLimiter = {
      acquire: async () => {
        throw new ModelRateLimitError('MODEL_RATE_LIMIT_EXCEEDED', '达到限流额度');
      },
    };
    const egress: ModelEgressPort = {
      postOpenAiCompatibleSse: async () => {
        providerCalls += 1;
        throw new Error('不应请求 Provider');
      },
    };
    const gateway = new OpenAiCompatibleModelGateway(egress, 3, undefined, limiter);

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: 'MODEL_RATE_LIMIT_EXCEEDED',
      retryable: true,
    });
    expect(providerCalls).toBe(0);
  });
});
