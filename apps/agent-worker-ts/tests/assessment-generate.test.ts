/**
 * assessment_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化改造后的单会话 ReAct 行为与保持不变的对外契约：
 * 输入默认值与题量校验、校验失败在同一会话内自纠、联网工具自由调用、
 * 轮数耗尽时的错误码、输出摘要键集合，以及回写载荷中的 plan_id 与元数据取值。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import { fakeToolDeps } from './helpers/fake-tool-gateway.js';
import type { DefaultModelConnectionEnvelope, PersistedAssessmentEnvelope } from '../src/schemas/core-internal.js';
import {
  runAssessmentGenerate,
  type AssessmentInternalPort,
  type AssessmentModelGatewayPort,
} from '../src/workflows/assessment-generate/index.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const CONNECTION_ID = '66666666-7777-4888-8999-000000000000';
const ASSESSMENT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

/**
 * 用共享包按 OWNER_ID 现场加密，确保 AAD 与所有者一致。
 * 不能直接复用 Python 的固定向量：那个向量的 AAD 绑定的是另一个 owner id，
 * 用它会导致认证失败（这本身就是 AAD 绑定生效的证明）。
 */
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

function question(index: number): Record<string, unknown> {
  return {
    prompt: '第 ' + String(index) + ' 题',
    options: [{ key: 'A', text: '选项 A' }, { key: 'B', text: '选项 B' }],
    answer_key: 'A',
    explanation: '解析',
    skill_tags: [],
    max_score: 1,
  };
}

function questionSetJson(count = 10, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 'assessment.single_choice.v1',
    questions: Array.from({ length: count }, (_, index) => ({ ...question(index + 1), ...extra })),
  });
}

const INPUT_SUMMARY = {
  topic: 'TypeScript 类型系统入门',
  title: 'TypeScript 类型系统入门',
  question_count: 10,
  difficulty: 'normal',
  kind: 'diagnostic',
};

class FakeInternal implements AssessmentInternalPort {
  readonly persisted: Array<Record<string, unknown>> = [];

  async getDefaultModelConnection(): Promise<DefaultModelConnectionEnvelope> {
    return {
      owner_id: OWNER_ID,
      connection_id: CONNECTION_ID,
      base_url: 'https://api.example.com',
      model_id: 'deepseek-flash',
      credential: CREDENTIAL,
    };
  }

  async persistAssessment(_agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope> {
    this.persisted.push(payload);
    return { assessment_id: ASSESSMENT_ID, status: 'ready', question_count: 10 };
  }
}

type Step = { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> } | { error: ModelGatewayError };

class FakeGateway implements AssessmentModelGatewayPort {
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

    await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: withoutDifficulty }, d);

    const userMessage = gateway.requests[0]?.messages[1];
    expect(String(userMessage?.content)).toContain('难度：normal');
  });

  it('diagnostic 题量不在 10-20 时判定为输入非法且不发模型请求', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson(5) }]);
    const { deps: d } = deps(gateway);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, question_count: 5 } }, d),
    ).rejects.toMatchObject({ code: 'ASSESSMENT_INPUT_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(0);
  });
});

describe('单会话 ReAct 行为', () => {
  it('首轮成功：只调用一次模型，输出摘要恰好 6 键，回写载荷含 plan_id 与元数据', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson() }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(Object.keys(result.outputSummary).sort()).toEqual([
      'assessment_id',
      'model_id',
      'question_count',
      'recovery_stage',
      'status',
      'tool_call_count',
    ]);
    expect(result.outputSummary.recovery_stage).toBe('initial');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);
    // 单会话：system 人格 + user 任务，没有 response_format 约束。
    expect(gateway.requests[0]?.messages).toHaveLength(2);
    expect(gateway.requests[0]?.responseFormat).toBeUndefined();

    const payload = internal.persisted[0];
    expect(payload?.plan_id).toBeNull();
    expect(payload?.schema_version).toBe('assessment.single_choice.v1');
    expect(payload?.generation_metadata).toMatchObject({
      tool_call_count: 0,
      search_extract: 'not_used',
      recovery_stage: 'initial',
      model_id: 'deepseek-flash',
    });
    expect((payload?.questions as unknown[]).length).toBe(10);
  });

  it('校验失败时在同一会话追加字段路径反馈后自纠，消息列表不重建', async () => {
    const firstOutput = '不是 JSON';
    const gateway = new FakeGateway([{ content: firstOutput }, { content: questionSetJson() }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.recovery_stage).toBe('repair');
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    // 前两条消息与首轮完全一致：没有重建消息列表。
    expect(messages[0]).toEqual(gateway.requests[0]?.messages[0]);
    expect(messages[1]).toEqual(gateway.requests[0]?.messages[1]);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: firstOutput });
    expect(messages[3]?.role).toBe('user');
    expect(String(messages[3]?.content)).toContain('校验失败的字段路径：response.json');
    expect(internal.persisted[0]?.generation_metadata).toMatchObject({
      tool_call_count: 0,
      recovery_stage: 'repair',
    });
  });

  it('跨轮次的 token 用量按真实值累加（与 Python 恒写 0 的差异）', async () => {
    const gateway = new FakeGateway([{ content: '不是 JSON' }, { content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    // 假网关每次返回 11/22，两轮共 22/44。
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });
    // 摘要仍是 Python 的 6 键，用量不污染 output_summary_json。
    expect(Object.keys(result.outputSummary)).not.toContain('input_tokens');
  });

  it('网关错误直接上抛，不再由工作流吞掉（交由任务级重试）', async () => {
    const gateway = new FakeGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', 'provider 内部错误', true) },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_500', retryable: true });
    expect(gateway.requests).toHaveLength(1);
  });

  it('轮数耗尽（reactMaxTurns）时抛 MODEL_STRUCTURED_OUTPUT_INVALID 并附带校验路径', async () => {
    const gateway = new FakeGateway([{ content: '{}' }, { content: '{}' }, { content: '{}' }]);
    const { deps: d } = deps(gateway, new FakeInternal(), 3);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_STRUCTURED_OUTPUT_INVALID', retryable: false });
    // 轮数上限即模型调用次数上限。
    expect(gateway.requests).toHaveLength(3);
  });

  it('模型自主调用 Tavily：工具结果以 tool 消息回传，真实 tool_call_count 写入摘要与元数据', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"TypeScript 5 新特性"}' }] },
      { content: questionSetJson() },
    ]);
    const { deps: d, internal } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(gateway.requests).toHaveLength(2);
    const secondMessages = gateway.requests[1]?.messages ?? [];
    const toolMessage = secondMessages[secondMessages.length - 1];
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.toolCallId).toBe('c1');
    expect(toolMessage?.name).toBe('tavily_search');
    expect(String(toolMessage?.content)).toContain('TAVILY_SEARCH_EXTRACT_OK');

    expect(result.outputSummary.tool_call_count).toBe(1);
    expect(result.outputSummary.recovery_stage).toBe('tavily_recovery');
    expect(internal.persisted[0]?.generation_metadata).toMatchObject({
      tool_call_count: 1,
      search_extract: 'tavily_search_then_extract',
      recovery_stage: 'tavily_recovery',
    });
  });

  it('题量与请求不一致时判为校验失败并进入自纠（questions 路径）', async () => {
    const gateway = new FakeGateway([{ content: questionSetJson(9) }, { content: questionSetJson(10) }]);
    const { deps: d } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.question_count).toBe(10);
    const messages = gateway.requests[1]?.messages ?? [];
    expect(String(messages[3]?.content)).toContain('questions');
  });
});
