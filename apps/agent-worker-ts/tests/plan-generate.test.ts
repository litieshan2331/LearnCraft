/**
 * plan_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化与 Python（plan_generate.py）逐项对齐的行为：三层输入契约、首轮 + 两次修复的
 * repair_attempts 取值、修复消息顺序、全部失败后进入无资料兜底重建、generation_path 与
 * fallback_used 的取值、6 键输出摘要与 5 键元数据，以及跨阶段真实 token 用量的累加。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import type { DefaultModelConnectionEnvelope, PersistedLearningPlanEnvelope } from '../src/schemas/core-internal.js';
import {
  runPlanGenerate,
  type PlanInternalPort,
  type PlanModelGatewayPort,
} from '../src/workflows/plan-generate.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const CONNECTION_ID = '66666666-7777-4888-8999-000000000000';
const PLAN_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

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

function planNode(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_key: 'chapter_' + String(index),
    ordinal: index,
    title: '第 ' + String(index) + ' 章',
    node_brief: '章节简介',
    learning_objective: '学习目标',
    rationale: '章节理由',
    difficulty: 2,
    estimated_minutes: 45,
    prerequisite_node_keys: index === 1 ? [] : ['chapter_' + String(index - 1)],
    completion_criteria: ['能完成示例'],
    ...overrides,
  };
}

function planJson(count = 6, overrides: (index: number) => Record<string, unknown> = () => ({})): string {
  return JSON.stringify({
    schema_version: 'learning_plan.v1',
    title: 'Python 学习路线',
    summary: '按章节组织的学习路线。',
    nodes: Array.from({ length: count }, (_, index) => planNode(index + 1, overrides(index + 1))),
  });
}

/** 旧字段 + 脏值的宽松输出，用于验证兜底阶段的规范化。 */
const LOOSE_PLAN_JSON = JSON.stringify({
  plan_title: '旧字段路线',
  description: '由旧版字段构成的摘要。',
  nodes: [
    { name: '第一章 变量', description: '变量说明', goal: '会定义变量', difficulty: 'beginner', duration_minutes: '30' },
    { title: '第二章 函数', objective: '会写函数', difficulty: 'hard', estimated_minutes: 90 },
    { title: '第三章 类', difficulty: 3, dependencies: ['第二章 函数'] },
    { title: '第四章 模块', difficulty: 3 },
    { title: '第五章 文件', difficulty: 4 },
    { title: '第六章 测试', difficulty: 4 },
  ],
});

const INPUT_SUMMARY = {
  goal: {
    id: 'goal-1',
    topic: 'Python 函数与类',
    title: 'Python 核心路线',
    description: '面向初学者的 Python 核心路线',
    desired_outcome: '能用函数与类组织一个可运行的小项目',
  },
  learner_profile: {
    profile_version: 1,
    current_level: 'beginner',
    weekly_minutes: 300,
  },
  diagnostic_assessment: {
    assessment_id: 'assessment-1',
    score_percent: 42.5,
    mastery_summary: { functions: 'weak', classes: 'unknown' },
  },
};

class FakeInternal implements PlanInternalPort {
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

  async persistLearningPlan(_agentRunId: string, payload: Record<string, unknown>): Promise<PersistedLearningPlanEnvelope> {
    this.persisted.push(payload);
    return { learning_plan_id: PLAN_ID, node_count: (payload.nodes as unknown[]).length };
  }
}

type Step = { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> } | { error: ModelGatewayError };

class FakeGateway implements PlanModelGatewayPort {
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
  it('三层对象都禁止多余字段', async () => {
    const gateway = new FakeGateway([{ content: planJson() }]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate(
        { runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, extra: 1 } },
        d,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INPUT_INVALID', retryable: false });

    await expect(
      runPlanGenerate(
        { runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, goal: { ...INPUT_SUMMARY.goal, extra: 1 } } },
        d,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INPUT_INVALID' });
    expect(gateway.requests).toHaveLength(0);
  });

  it('学习者水平或每周时长越界时判定为输入非法', async () => {
    const gateway = new FakeGateway([{ content: planJson() }]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate(
        {
          runId: 'run-1',
          inputSummaryJson: {
            ...INPUT_SUMMARY,
            learner_profile: { ...INPUT_SUMMARY.learner_profile, current_level: 'expert' },
          },
        },
        d,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INPUT_INVALID' });

    await expect(
      runPlanGenerate(
        {
          runId: 'run-1',
          inputSummaryJson: {
            ...INPUT_SUMMARY,
            learner_profile: { ...INPUT_SUMMARY.learner_profile, weekly_minutes: 10 },
          },
        },
        d,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INPUT_INVALID' });
  });

  it('user 提示词包含目标、画像与前测摘要，且不含联网工具描述', async () => {
    const gateway = new FakeGateway([{ content: planJson() }]);
    const { deps: d } = deps(gateway);

    await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const systemContent = String(gateway.requests[0]?.messages[0]?.content);
    const userContent = String(gateway.requests[0]?.messages[1]?.content);
    expect(systemContent).toContain('你是 LearnCraft 的学习路线规划师。');
    expect(systemContent).toContain('本次不提供任何联网检索工具');
    expect(userContent).toContain('学习主题：Python 函数与类');
    expect(userContent).toContain('学习者水平：beginner');
    expect(userContent).toContain('每周可用分钟：300');
    expect(userContent).toContain('前测得分：42.5');
    expect(userContent).toContain('前测薄弱点摘要：{"functions":"weak","classes":"unknown"}');
  });
});

describe('校验与修复', () => {
  it('首轮合法：repair_attempts=0，摘要 6 键，元数据 5 键', async () => {
    const gateway = new FakeGateway([{ content: planJson() }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(Object.keys(result.outputSummary).sort()).toEqual([
      'generation_path',
      'learning_plan_id',
      'model_id',
      'node_count',
      'repair_attempts',
      'tool_call_count',
    ]);
    expect(result.outputSummary).toMatchObject({
      repair_attempts: 0,
      generation_path: 'model_knowledge',
      tool_call_count: 0,
      learning_plan_id: PLAN_ID,
      node_count: 6,
      model_id: 'deepseek-flash',
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);

    const payload = internal.persisted[0];
    expect(payload?.schema_version).toBe('learning_plan.v1');
    expect(payload?.generation_metadata).toEqual({
      model_id: 'deepseek-flash',
      tool_call_count: 0,
      repair_attempts: 0,
      generation_path: 'model_knowledge',
      fallback_used: false,
    });
    expect((payload?.nodes as unknown[]).length).toBe(6);
  });

  it('首轮结构非法（依赖成环）后一次修复成功，repair_attempts=1', async () => {
    const cyclic = JSON.stringify({
      schema_version: 'learning_plan.v1',
      title: '环状路线',
      summary: '依赖成环。',
      nodes: [
        planNode(1, { prerequisite_node_keys: ['chapter_2'] }),
        planNode(2, { prerequisite_node_keys: ['chapter_1'] }),
        planNode(3), planNode(4), planNode(5), planNode(6),
      ],
    });
    const gateway = new FakeGateway([{ content: cyclic }, { content: planJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.repair_attempts).toBe(1);
    expect(result.outputSummary.generation_path).toBe('model_knowledge');
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });

    const repairMessages = gateway.requests[1]?.messages ?? [];
    expect(repairMessages).toHaveLength(4);
    expect(repairMessages[2]).toMatchObject({ role: 'assistant', content: cyclic });
    expect(repairMessages[3]?.role).toBe('system');
    expect(String(repairMessages[3]?.content)).toContain('上一轮路线不符合输出 Schema 或章节依赖规则');
  });

  it('首轮无正文时抛 MODEL_PROVIDER_RESPONSE_INVALID，不进入修复', async () => {
    const gateway = new FakeGateway([{ content: null }]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_RESPONSE_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(1);
  });
});

describe('兜底重建', () => {
  it('首轮与两次修复都失败后进入无资料重建，旧字段输出被规范化后成功落库', async () => {
    const gateway = new FakeGateway([
      { content: '{}' },
      { content: '{}' },
      { content: '{}' },
      { content: LOOSE_PLAN_JSON },
    ]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary).toMatchObject({
      repair_attempts: 2,
      generation_path: 'tavily_recovery',
      node_count: 6,
    });
    expect(gateway.requests).toHaveLength(4);

    const recoveryRequest = gateway.requests[3];
    const recoverySystem = String(recoveryRequest?.messages[0]?.content);
    const recoveryUser = String(recoveryRequest?.messages[1]?.content);
    expect(recoverySystem).toContain('Tavily 联网兜底暂时不可用');
    expect(recoveryUser).toContain('Tavily 错误类别：TAVILY_TOOL_NOT_AVAILABLE');

    const payload = internal.persisted[0];
    expect(payload?.generation_metadata).toEqual({
      model_id: 'deepseek-flash',
      tool_call_count: 0,
      repair_attempts: 2,
      generation_path: 'tavily_recovery',
      fallback_used: true,
    });
    const nodes = payload?.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node.node_key)).toEqual([
      'chapter_1', 'chapter_2', 'chapter_3', 'chapter_4', 'chapter_5', 'chapter_6',
    ]);
    expect(nodes[0]).toMatchObject({ difficulty: 1, estimated_minutes: 30, prerequisite_node_keys: [] });
    // 第三节以标题声明依赖，被解析为第二节的 node_key。
    expect(nodes[2]?.prerequisite_node_keys).toEqual(['chapter_2']);
  });

  it('兜底结果仍无法规范化时抛 PLAN_MODEL_RECOVERY_INVALID 并附带校验路径', async () => {
    const gateway = new FakeGateway([
      { content: '{}' },
      { content: '{}' },
      { content: '{}' },
      { content: '{"nodes": {}}' },
      { content: '{"nodes": {}}' },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({
      code: 'PLAN_MODEL_RECOVERY_INVALID',
      message: '无资料模型恢复结果仍不符合路线合同。 校验路径: nodes',
      retryable: false,
    });
  });

  it('兜底结果节点数不足 6 章时最终失败', async () => {
    const tooFew = planJson(3);
    const gateway = new FakeGateway([
      { content: '{}' },
      { content: '{}' },
      { content: '{}' },
      { content: tooFew },
      { content: tooFew },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({
      code: 'PLAN_MODEL_RECOVERY_INVALID',
      message: '无资料模型恢复结果仍不符合路线合同。 校验路径: nodes',
    });
  });
});
