/**
 * ReAct 会话循环的单元测试（使用假网关与假工具网关，不发真实请求）。
 *
 * 重点固化单会话语义：
 * - 工具成功与失败都以 tool 消息回传**同一会话**，模型据此继续；
 * - 校验失败不回重建消息列表，而是在同一会话尾部追加一条 user 观察消息；
 * - 达到可见工具调用上限后不再提供工具；
 * - 轮数上限即模型调用次数上限，耗尽时抛调用方给定的不可重试错误码；
 * - 返回值携带 toolCallCount / turns / validationFailures 供元数据映射。
 */
import { describe, expect, it } from 'vitest';

import {
  runReactAgentSession,
  serializeToolResult,
  TOOL_CALL_LIMIT_REACHED,
  type ToolGatewayPort,
} from '../src/application/services/tool-aware-generator.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelToolCall,
} from '../src/infrastructure/llm/model-gateway.js';
import type { ToolExecutionResult } from '../src/infrastructure/mcp/tavily-tool-gateway.js';

type Step =
  | { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> }
  | { error: ModelGatewayError };

class ScriptedGateway {
  readonly requests: ModelCompletionRequest[] = [];

  constructor(private readonly script: Step[]) {}

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    this.requests.push(request);
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error('脚本步骤用尽');
    }
    if ('error' in step) {
      throw step.error;
    }
    return {
      message: { role: 'assistant', content: step.content ?? null, toolCalls: step.toolCalls ?? [] },
      usage: { inputTokens: 1, outputTokens: 2 },
      finishReason: 'stop',
    };
  }
}

class ScriptedToolGateway implements ToolGatewayPort {
  readonly calls: ModelToolCall[] = [];

  constructor(private readonly result: ToolExecutionResult) {}

  async execute(toolCall: ModelToolCall): Promise<ToolExecutionResult> {
    this.calls.push(toolCall);
    return this.result;
  }
}

const OK_RESULT: ToolExecutionResult = {
  ok: true,
  code: 'TAVILY_SEARCH_EXTRACT_OK',
  message: '已完成搜索并提取排名靠前的来源。',
  data: { query: 'q', sources: [] },
};

const FAILED_RESULT: ToolExecutionResult = {
  ok: false,
  code: 'TAVILY_MCP_UNAVAILABLE',
  message: '联网工具暂时不可用。',
  data: {},
};

const REQUEST = {
  agentRunId: 'run-1',
  connection: {
    ownerId: 'owner-1',
    connectionId: 'connection-1',
    baseUrl: 'https://api.example.com',
    modelId: 'deepseek-flash',
    apiKey: 'sk-test',
  },
  messages: [
    { role: 'system' as const, content: '人格' },
    { role: 'user' as const, content: '任务' },
  ],
};

/** parse：只接受 'OK'，其它内容一律判为失败并给出固定路径。 */
function parseOk(content: string): { value: string | null; paths: string[] } {
  return content.trim() === 'OK' ? { value: content.trim(), paths: [] } : { value: null, paths: ['questions'] };
}

function feedback(context: { turn: number; paths: readonly string[] }): string {
  return '第 ' + String(context.turn) + ' 轮失败：' + context.paths.join(', ');
}

function input(gateway: ScriptedGateway, toolGateway: ToolGatewayPort, overrides: Partial<{
  maxTurns: number;
  maxToolCalls: number;
}> = {}) {
  return {
    complete: (request: ModelCompletionRequest) => gateway.complete(request),
    toolGateway,
    maxTurns: overrides.maxTurns ?? 5,
    maxToolCalls: overrides.maxToolCalls ?? 3,
    request: REQUEST,
    parse: parseOk,
    buildFeedback: feedback,
    exhaustedErrorCode: 'TEST_EXHAUSTED',
    exhaustedMessage: '测试用尽。',
  };
}

describe('runReactAgentSession', () => {
  it('首轮通过：只调用一次模型，turns=1 且没有校验失败', async () => {
    const gateway = new ScriptedGateway([{ content: 'OK' }]);
    const result = await runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT)));

    expect(result).toEqual({ value: 'OK', toolCallCount: 0, turns: 1, validationFailures: 0 });
    expect(gateway.requests).toHaveLength(1);
  });

  it('工具结果以 tool 消息回传同一会话，模型据此继续并在下一轮通过', async () => {
    const tools = new ScriptedToolGateway(OK_RESULT);
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"q"}' }] },
      { content: 'OK' },
    ]);

    const result = await runReactAgentSession(input(gateway, tools));

    expect(result.toolCallCount).toBe(1);
    expect(result.turns).toBe(2);
    expect(tools.calls).toHaveLength(1);
    // 第二次请求的会话在原有两条消息之后追加了 assistant（含工具调用）与 tool 结果。
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({ role: 'assistant' });
    expect(messages[3]).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 'tavily_search' });
    expect(String(messages[3]?.content)).toBe(serializeToolResult(OK_RESULT));
  });

  it('工具失败不中断会话：失败结果编码成 tool 消息交给模型继续思考', async () => {
    const tools = new ScriptedToolGateway(FAILED_RESULT);
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      { content: 'OK' },
    ]);

    const result = await runReactAgentSession(input(gateway, tools));

    expect(result.value).toBe('OK');
    const messages = gateway.requests[1]?.messages ?? [];
    expect(String(messages[3]?.content)).toContain('TAVILY_MCP_UNAVAILABLE');
    expect(String(messages[3]?.content)).toContain('"ok":false');
  });

  it('校验失败时在同一会话追加 user 观察消息，不回重建消息列表', async () => {
    const gateway = new ScriptedGateway([{ content: '坏输出' }, { content: 'OK' }]);

    const result = await runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT)));

    expect(result.validationFailures).toBe(1);
    expect(result.turns).toBe(2);
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: '坏输出' });
    expect(messages[3]).toMatchObject({ role: 'user', content: '第 1 轮失败：questions' });
  });

  it('模型既没有正文也没有工具调用时按一次校验失败处理', async () => {
    const gateway = new ScriptedGateway([{ content: null }, { content: 'OK' }]);

    const result = await runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT)));

    expect(result.validationFailures).toBe(1);
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(String(messages[2]?.content)).toContain('response.content_missing');
  });

  it('达到工具调用上限后不再提供工具，并给出 TOOL_CALL_LIMIT_REACHED', async () => {
    const tools = new ScriptedToolGateway(OK_RESULT);
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      {
        content: null,
        toolCalls: [
          { id: 'c2', name: 'tavily_search', argumentsJson: '{}' },
          { id: 'c3', name: 'tavily_search', argumentsJson: '{}' },
        ],
      },
      { content: 'OK' },
    ]);

    const result = await runReactAgentSession(input(gateway, tools, { maxToolCalls: 1 }));

    expect(result.toolCallCount).toBe(1);
    expect(tools.calls).toHaveLength(1);
    // 第二次请求只提供一次工具预算，第三个调用被拒绝并回传稳定错误码。
    const thirdMessages = gateway.requests[2]?.messages ?? [];
    const rejected = thirdMessages.find((message) => String(message.content).includes(TOOL_CALL_LIMIT_REACHED));
    expect(rejected?.role).toBe('tool');
    // 预算用尽后第三次请求不再携带工具。
    expect(gateway.requests[2]?.tools).toEqual([]);
    expect(gateway.requests[2]?.toolChoice).toBe('none');
  });

  it('轮数耗尽时抛调用方给定的不可重试错误码，并只调用 maxTurns 次', async () => {
    const gateway = new ScriptedGateway([{ content: '坏' }, { content: '坏' }, { content: '坏' }]);

    await expect(
      runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT), { maxTurns: 3 })),
    ).rejects.toMatchObject({
      code: 'TEST_EXHAUSTED',
      retryable: false,
      validationPaths: ['questions'],
    });
    expect(gateway.requests).toHaveLength(3);
  });

  it('网关错误直接上抛，不由循环吞掉（由任务级重试处理）', async () => {
    const gateway = new ScriptedGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', 'provider 内部错误', true) },
    ]);

    await expect(
      runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT))),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_500', retryable: true });
  });

  it('工具预算充足时每轮都携带 tavily_search 且 toolChoice=auto', async () => {
    const gateway = new ScriptedGateway([{ content: 'OK' }]);
    await runReactAgentSession(input(gateway, new ScriptedToolGateway(OK_RESULT)));

    expect(gateway.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['tavily_search']);
    expect(gateway.requests[0]?.toolChoice).toBe('auto');
    // ReAct 会话不使用 response_format 约束，最终 JSON 靠提示词与解析器。
    expect(gateway.requests[0]?.responseFormat).toBeUndefined();
  });
});
