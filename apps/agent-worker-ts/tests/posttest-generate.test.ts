/**
 * posttest_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化改造后的单会话 ReAct 行为与保持不变的对外契约：
 * 输入契约（extra 禁止、kind/题量/绑定字段）、内部接口调用顺序、固定节点内容在提示词中的
 * 序列化顺序、**后测全程开放联网工具的边界变更**、自纠反馈、错误码与 5 键输出摘要。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import { fakeToolDeps } from './helpers/fake-tool-gateway.js';
import type {
  CardContentContextEnvelope,
  DefaultModelConnectionEnvelope,
  PersistedAssessmentEnvelope,
} from '../src/schemas/core-internal.js';
import {
  runPosttestGenerate,
  type PosttestInternalPort,
  type PosttestModelGatewayPort,
} from '../src/workflows/posttest-generate/index.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const CONNECTION_ID = '66666666-7777-4888-8999-000000000000';
const ASSESSMENT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PLAN_NODE_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const CARD_CONTENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function buildCredential(ownerId: string): DefaultModelConnectionEnvelope['credential'] {
  const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_BASE64;
  try {
    const encrypted = encryptCredential('sk-test-key', ownerId);
    return {
      ciphertext_base64: encrypted.ciphertext.toString('base64'),
      iv_base64: encrypted.iv.toString('base64'),
      auth_tag_base64: encrypted.authTag.toString('base64'),
      encryption_key_version: 'local-v1',
    };
  } finally {
    if (previousKey === undefined) {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
    }
  }
}

const CREDENTIAL = buildCredential(OWNER_ID);

/** 字段顺序与 Web 内部接口的响应一致，序列化后应与 Python 的 orjson.dumps 完全一致。 */
const CARD_CONTENT_CONTEXT: CardContentContextEnvelope = {
  plan_node_id: PLAN_NODE_ID,
  card_content_id: CARD_CONTENT_ID,
  foundation: '函数的定义与调用。',
  worked_example: { title: '求和函数', code: 'def add(a, b):' },
  pitfalls_debug: [{ title: '缺少返回值', cause: '函数体里忘记写 return。', fix: '在末尾补上 return 表达式。' }],
  teaching_memory: { summary: '记住参数与返回值。' },
};

function question(index: number): Record<string, unknown> {
  return {
    prompt: '后测第 ' + String(index) + ' 题',
    options: [{ key: 'A', text: '选项 A' }, { key: 'B', text: '选项 B' }],
    answer_key: 'A',
    explanation: '解析',
    skill_tags: [],
    max_score: 1,
  };
}

function questionSetJson(count = 5): string {
  return JSON.stringify({
    schema_version: 'assessment.single_choice.v1',
    questions: Array.from({ length: count }, (_, index) => question(index + 1)),
  });
}

const INPUT_SUMMARY = {
  topic: '函数与参数',
  question_count: 5,
  difficulty: 'normal',
  kind: 'post_test',
  plan_node_id: PLAN_NODE_ID,
  source_card_content_id: CARD_CONTENT_ID,
};

class FakeInternal implements PosttestInternalPort {
  readonly persisted: Array<Record<string, unknown>> = [];
  readonly calls: string[] = [];

  async getCardContentContext(): Promise<CardContentContextEnvelope> {
    this.calls.push('card_content_context');
    return CARD_CONTENT_CONTEXT;
  }

  async getDefaultModelConnection(): Promise<DefaultModelConnectionEnvelope> {
    this.calls.push('default_model_connection');
    return {
      owner_id: OWNER_ID,
      connection_id: CONNECTION_ID,
      base_url: 'https://api.example.com',
      model_id: 'deepseek-flash',
      credential: CREDENTIAL,
    };
  }

  async persistAssessment(_agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope> {
    this.calls.push('persist_assessment');
    this.persisted.push(payload);
    return { assessment_id: ASSESSMENT_ID, status: 'ready', question_count: 5 };
  }
}

type Step = { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> } | { error: ModelGatewayError };

class FakeGateway implements PosttestModelGatewayPort {
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
      message: {
        role: 'assistant',
        content: step.content ?? null,
        toolCalls: step.toolCalls ?? [],
      },
      usage: { inputTokens: 11, outputTokens: 22 },
      finishReason: 'stop',
    };
  }
}

function deps(gateway: FakeGateway, internal = new FakeInternal(), reactMaxTurns = 5) {
  return {
    deps: {
      internalClient: internal,
      decryptor: new ModelCredentialDecryptor(KEY_BASE64, 'local-v1'),
      gateway,
      ...fakeToolDeps(),
      reactMaxTurns,
    },
    internal,
  };
}

describe('输入契约', () => {
  it('缺省 difficulty 时使用 normal，且 user 提示词包含该值', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d } = deps(gateway);
    const { difficulty: _omitted, ...withoutDifficulty } = INPUT_SUMMARY;

    await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: withoutDifficulty }, d);

    const userMessage = gateway.requests[0]?.messages[1];
    expect(String(userMessage?.content)).toContain('难度：normal');
  });

  it('kind 不是 post_test 时判定为输入非法且不发任何内部请求', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d, internal } = deps(gateway);

    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, kind: 'diagnostic' } }, d),
    ).rejects.toMatchObject({ code: 'POSTTEST_INPUT_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(0);
    expect(internal.calls).toHaveLength(0);
  });

  it('多余字段被拒绝（Python 使用 extra=forbid）', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, extra: 'x' } }, d),
    ).rejects.toMatchObject({ code: 'POSTTEST_INPUT_INVALID' });
    expect(gateway.requests).toHaveLength(0);
  });

  it('题量超过 10 或缺少节点绑定字段时判定为输入非法', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, question_count: 11 } }, d),
    ).rejects.toMatchObject({ code: 'POSTTEST_INPUT_INVALID' });

    const { plan_node_id: _omitted, ...withoutNode } = INPUT_SUMMARY;
    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: withoutNode }, d),
    ).rejects.toMatchObject({ code: 'POSTTEST_INPUT_INVALID' });
  });
});

describe('单会话 ReAct 行为', () => {
  it('内部接口调用顺序为先内容上下文、再默认模型连接、最后回写', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d, internal } = deps(gateway);

    await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(internal.calls).toEqual(['card_content_context', 'default_model_connection', 'persist_assessment']);
  });

  it('首轮成功：输出摘要恰好 5 键，回写载荷绑定节点与来源内容', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(Object.keys(result.outputSummary).sort()).toEqual([
      'assessment_id',
      'model_id',
      'question_count',
      'recovery_stage',
      'tool_call_count',
    ]);
    expect(result.outputSummary.recovery_stage).toBe('initial');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);

    const payload = internal.persisted[0];
    expect(payload?.kind).toBe('post_test');
    expect(payload?.plan_id).toBeNull();
    expect(payload?.plan_node_id).toBe(PLAN_NODE_ID);
    expect(payload?.source_card_content_id).toBe(CARD_CONTENT_ID);
    expect(payload?.generation_metadata).toEqual({
      model_id: 'deepseek-flash',
      source_card_content_id: CARD_CONTENT_ID,
      tool_call_count: 0,
      recovery_stage: 'initial',
    });
    expect((payload?.questions as unknown[]).length).toBe(5);
  });

  it('user 提示词嵌入的固定节点内容按契约字段顺序序列化', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const userContent = String(gateway.requests[0]?.messages[1]?.content);
    expect(userContent).toContain('后测主题：函数与参数');
    expect(userContent).toContain('题目数量：5');
    expect(userContent.endsWith('固定节点内容(JSON)：' + JSON.stringify(CARD_CONTENT_CONTEXT))).toBe(true);
  });

  it('system 提示词以节点内容为主要依据，并按新边界全程允许联网核对', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const systemContent = String(gateway.requests[0]?.messages[0]?.content);
    expect(systemContent).toContain('你是 LearnCraft 的 Node Tutor 后测设计师。');
    expect(systemContent).toContain('主要出题依据');
    expect(systemContent).toContain('tavily_search');
    // 产品边界变更：不再出现「不得引入外部新知识」这类禁止联网的表述。
    expect(systemContent).not.toContain('不得引入外部新知识');
  });

  it('整个会话都携带工具（首轮即开放），工具调用写入 recovery_stage=tavily_recovery', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"Python 函数"}' }] },
      { content: questionSetJson() },
    ]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(gateway.requests).toHaveLength(2);
    for (const request of gateway.requests) {
      expect(request.tools?.map((tool) => tool.name)).toEqual(['tavily_search']);
    }
    expect(result.outputSummary.tool_call_count).toBe(1);
    expect(result.outputSummary.recovery_stage).toBe('tavily_recovery');
    expect(internal.persisted[0]?.generation_metadata).toMatchObject({
      tool_call_count: 1,
      recovery_stage: 'tavily_recovery',
    });
  });

  it('校验失败时在同一会话追加字段路径反馈后自纠，消息列表不重建', async () => {
    const firstOutput = '不是 JSON';
    const gateway = new FakeGateway([{ content: firstOutput }, { content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.recovery_stage).toBe('repair');
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual(gateway.requests[0]?.messages[0]);
    expect(messages[1]).toEqual(gateway.requests[0]?.messages[1]);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: firstOutput });
    expect(messages[3]?.role).toBe('user');
    expect(String(messages[3]?.content)).toContain('校验失败的字段路径：response.json');
  });

  it('跨轮次的 token 用量按真实值累加，且不污染输出摘要', async () => {
    const gateway = new FakeGateway([{ content: '不是 JSON' }, { content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });
    expect(Object.keys(result.outputSummary)).not.toContain('input_tokens');
  });

  it('题量与请求始终不一致时映射为 POSTTEST_OUTPUT_INVALID 并附带 questions 路径', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson(4) }, { content: questionSetJson(4) }, { content: questionSetJson(4) }]);
    const { deps: d } = deps(gateway, new FakeInternal(), 3);

    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({
      code: 'POSTTEST_OUTPUT_INVALID',
      retryable: false,
      validationPaths: ['questions'],
    });
    expect(gateway.requests).toHaveLength(3);
  });

  it('网关错误直接上抛（交由任务级重试）', async () => {
    const gateway = new FakeGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_429', '限流', true) },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runPosttestGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_429', retryable: true });
    expect(gateway.requests).toHaveLength(1);
  });
});
