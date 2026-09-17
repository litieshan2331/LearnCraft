/**
 * assessment_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化与 Python（question_set_generation.py / assessment_generate.py）逐项对齐的行为：
 * 输入默认值与题量校验、修复请求的消息顺序、任何网关错误都继续下一阶段、
 * 全部失败时的错误取舍、输出摘要键集合，以及回写载荷中的 plan_id 与元数据。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import type { DefaultModelConnectionEnvelope, PersistedAssessmentEnvelope } from '../src/schemas/core-internal.js';
import {
  runAssessmentGenerate,
  type AssessmentInternalPort,
  type AssessmentModelGatewayPort,
} from '../src/workflows/assessment-generate.js';

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

function deps(gateway: FakeGateway, internal = new FakeInternal()) {
  return {
    deps: {
      internalClient: internal,
      decryptor: new ModelCredentialDecryptor(KEY_BASE64, 'local-v1'),
      gateway,
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

describe('阶段控制流', () => {
  it('首轮成功：输出摘要恰好 6 键，回写载荷含 plan_id 与元数据', async () => {
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

  it('首轮结构失败后，修复请求依次追加上一轮原文与修复指令', async () => {
    const firstOutput = '不是 JSON';
    const gateway = new FakeGateway([{ content: firstOutput }, { content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.recovery_stage).toBe('repair');
    const repairMessages = gateway.requests[1]?.messages ?? [];
    expect(repairMessages).toHaveLength(4);
    expect(repairMessages[2]).toMatchObject({ role: 'assistant', content: firstOutput });
    expect(repairMessages[3]?.role).toBe('system');
    expect(String(repairMessages[3]?.content)).toContain('请修复题集 JSON');
  });

  it('跨阶段的 token 用量按真实值累加（与 Python 恒写 0 的差异）', async () => {
    const gateway = new FakeGateway([{ content: '不是 JSON' }, { content: questionSetJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    // 假网关每次返回 11/22，两个阶段共 22/44。
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });
    // 摘要仍是 Python 的 6 键，用量不污染 output_summary_json。
    expect(Object.keys(result.outputSummary)).not.toContain('input_tokens');
  });

  it('非结构类网关错误同样继续进入修复阶段', async () => {
    const gateway = new FakeGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', 'provider 内部错误', true) },
      { content: questionSetJson() },
    ]);
    const { deps: d } = deps(gateway);

    const result = await runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(gateway.requests).toHaveLength(2);
    expect(result.outputSummary.recovery_stage).toBe('repair');
  });

  it('两阶段都结构失败时汇总校验路径抛出 MODEL_STRUCTURED_OUTPUT_INVALID', async () => {
    const gateway = new FakeGateway([{ content: '{}' }, { content: '{}' }]);
    const { deps: d } = deps(gateway);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_STRUCTURED_OUTPUT_INVALID', retryable: false });
  });

  it('最后一个是非结构错误时原样上抛该错误', async () => {
    const gateway = new FakeGateway([
      { content: '{}' },
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_429', '限流', true) },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_429', retryable: true });
  });

  it('模型只返回工具调用而无正文时按 response.content_missing 判为结构错误', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      { content: null, toolCalls: [{ id: 'c2', name: 'tavily_search', argumentsJson: '{}' }] },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runAssessmentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({
      code: 'MODEL_STRUCTURED_OUTPUT_INVALID',
      validationPaths: ['response.content_missing'],
    });
  });
});
