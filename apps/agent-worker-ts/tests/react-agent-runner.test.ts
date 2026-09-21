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
import type {
  AgentProgressReporter,
  AgentProgressStep,
} from '../src/application/services/agent-progress.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelToolCall,
} from '../src/infrastructure/llm/model-gateway.js';
import type { ToolExecutionResult } from '../src/infrastructure/mcp/tavily-tool-gateway.js';

type Step =
  | {
    content?: string | null;
    toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
    /** 该轮模型思考原文（网关聚合后的 reasoningContent）。 */
    reasoning?: string;
    /** 该轮流式思考增量（按顺序回调 onReasoningDelta，模拟真实流式）。 */
    reasoningDeltas?: string[];
  }
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
    // 模拟真实流式：增量在本次调用返回前逐块回调。
    for (const chunk of step.reasoningDeltas ?? []) {
      request.onReasoningDelta?.(chunk);
    }
    return {
      message: {
        role: 'assistant',
        content: step.content ?? null,
        toolCalls: step.toolCalls ?? [],
        reasoningContent: step.reasoning ?? null,
      },
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
  onProgress: AgentProgressReporter;
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
    ...(overrides.onProgress === undefined ? {} : { onProgress: overrides.onProgress }),
  };
}

/** 记录型进度上报器：断言上报顺序与内容。 */
class RecordingProgressReporter implements AgentProgressReporter {
  readonly events: Array<{ step: string; data?: Record<string, string | number | boolean> }> = [];

  report(step: AgentProgressStep, data?: Record<string, string | number | boolean>): void {
    this.events.push(data === undefined ? { step } : { step, data });
  }

  get steps(): string[] {
    return this.events.map((event) => event.step);
  }
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

describe('进度上报', () => {
  it('首轮通过只上报一次 turn.started，且带轮数上限', async () => {
    const gateway = new ScriptedGateway([{ content: 'OK' }]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    expect(progress.steps).toEqual(['turn.started']);
    expect(progress.events[0]?.data).toMatchObject({ turn: 1, max_turns: 5 });
  });

  it('工具轮上报检索词与来源条数，且不包含工具返回内容', async () => {
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"TypeScript 5 类型"}' }] },
      { content: 'OK' },
    ]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    expect(progress.steps).toEqual(['turn.started', 'tool.called', 'tool.completed', 'turn.started']);
    expect(progress.events[1]?.data).toMatchObject({
      turn: 1,
      call_index: 1,
      tool: 'tavily_search',
      query: 'TypeScript 5 类型',
    });
    expect(progress.events[2]?.data).toMatchObject({
      ok: true,
      code: 'TAVILY_SEARCH_EXTRACT_OK',
      source_count: 0,
    });
    // 只上报元数据：工具返回的 message/data 原文不出现在事件里。
    expect(JSON.stringify(progress.events)).not.toContain('已完成搜索并提取排名靠前的来源');
  });

  it('工具失败时上报受控失败类别，会话继续', async () => {
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      { content: 'OK' },
    ]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(FAILED_RESULT), { onProgress: progress }),
    );

    expect(progress.events[2]?.data).toMatchObject({ ok: false, code: 'TAVILY_MCP_UNAVAILABLE' });
    expect(progress.steps).toContain('turn.started');
  });

  it('校验失败上报字段路径与自纠，且不回显模型正文', async () => {
    const gateway = new ScriptedGateway([{ content: '坏输出' }, { content: 'OK' }]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    expect(progress.steps).toEqual(['turn.started', 'validation.failed', 'turn.self_correcting', 'turn.started']);
    expect(progress.events[1]?.data).toMatchObject({ turn: 1, paths: 'questions' });
    expect(progress.events[2]?.data).toMatchObject({ turn: 1, next_turn: 2 });
    expect(JSON.stringify(progress.events)).not.toContain('坏输出');
  });

  it('轮数耗尽时上报 run.failed 与不可重试标记，且不含模型正文', async () => {
    const gateway = new ScriptedGateway([{ content: '坏' }, { content: '坏' }]);
    const progress = new RecordingProgressReporter();

    await expect(
      runReactAgentSession(
        input(gateway, new ScriptedToolGateway(OK_RESULT), { maxTurns: 2, onProgress: progress }),
      ),
    ).rejects.toMatchObject({ code: 'TEST_EXHAUSTED' });

    expect(progress.steps[progress.steps.length - 1]).toBe('run.failed');
    expect(progress.events[progress.events.length - 1]?.data).toMatchObject({
      code: 'TEST_EXHAUSTED',
      retryable: false,
      validation_failures: 2,
      tool_call_count: 0,
    });
    expect(JSON.stringify(progress.events)).not.toContain('"坏"');
  });

  it('每轮结束后上报该轮思考原文（thinking.completed）', async () => {
    const gateway = new ScriptedGateway([
      { reasoning: '先确认考点范围。', content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      { reasoning: '资料足够，开始出题。', content: 'OK' },
    ]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    const thinking = progress.events.filter((event) => event.step === 'thinking.completed');
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.data).toMatchObject({ turn: 1, text: '先确认考点范围。' });
    expect(thinking[1]?.data).toMatchObject({ turn: 2, text: '资料足够，开始出题。' });
  });

  it('流式增量合并后上报 thinking.delta，累计内容与增量一致', async () => {
    const deltas = ['甲'.repeat(120), '乙'.repeat(120), '丙'];
    const gateway = new ScriptedGateway([{ reasoningDeltas: deltas, content: 'OK' }]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    const chunks = progress.events.filter((event) => event.step === 'thinking.delta');
    // 200 字符阈值：前两段合成一条，剩余部分在轮末补发。
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((event) => String(event.data?.text)).join('')).toBe(deltas.join(''));
    expect(chunks.every((event) => event.data?.turn === 1)).toBe(true);
  });

  it('增量未达阈值时在轮末补发，且仍上报权威整段', async () => {
    const gateway = new ScriptedGateway([
      { reasoningDeltas: ['很短的一段'], reasoning: '很短的一段', content: 'OK' },
    ]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    const deltas = progress.events.filter((event) => event.step === 'thinking.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.data?.text).toBe('很短的一段');
    expect(progress.steps).toContain('thinking.completed');
  });

  it('没有思考原文时不上报 thinking.completed', async () => {
    const gateway = new ScriptedGateway([{ reasoning: '   ', content: 'OK' }]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    expect(progress.steps).toEqual(['turn.started']);
  });

  it('超长检索词被截断后再上报', async () => {
    const longQuery = 'x'.repeat(300);
    const gateway = new ScriptedGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: JSON.stringify({ query: longQuery }) }] },
      { content: 'OK' },
    ]);
    const progress = new RecordingProgressReporter();

    await runReactAgentSession(
      input(gateway, new ScriptedToolGateway(OK_RESULT), { onProgress: progress }),
    );

    expect(String(progress.events[1]?.data?.query)).toHaveLength(120);
  });
});
