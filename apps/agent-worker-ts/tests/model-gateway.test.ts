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

  async postOpenAiCompatibleSse(input: ModelEgressCallInput): Promise<{ statusCode: number; events: unknown[] }> {
    this.calls.push(input);
    const result = this.responder(input);
    if (result instanceof Error) {
      throw result;
    }
    return { statusCode: 200, events: result };
  }
}

function event(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { choices: [{ index: 0, delta }], ...extra };
}

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
