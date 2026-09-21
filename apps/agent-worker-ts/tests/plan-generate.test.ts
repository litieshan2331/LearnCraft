/**
 * plan_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化改造后的单会话 ReAct 行为与保持不变的对外契约：三层输入契约、会话内自纠的
 * repair_attempts 取值、宽松规范化仍在会话内生效、generation_path 与 fallback_used 的语义映射、
 * 6 键输出摘要与 5 键元数据，以及跨轮次真实 token 用量的累加。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import { fakeToolDeps, SUCCESSFUL_TOOL_RESULT } from './helpers/fake-tool-gateway.js';
import type { DefaultModelConnectionEnvelope, PersistedLearningPlanEnvelope } from '../src/schemas/core-internal.js';
import {
  planGenerationPath,
  runPlanGenerate,
  type PlanInternalPort,
  type PlanModelGatewayPort,
} from '../src/workflows/plan-generate/index.js';

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

/** 依赖成环的非法路线（严格校验与宽松规范化都无法通过）。 */
function cyclicPlanJson(): string {
  return planJson(6, (index) => {
    if (index === 2) {
      return { prerequisite_node_keys: ['chapter_3'] };
    }
    if (index === 3) {
      return { prerequisite_node_keys: ['chapter_2'] };
    }
    return {};
  });
}

/** 旧字段 + 脏值的宽松输出，用于验证会话内宽松规范化仍然生效。 */
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

function deps(gateway: FakeGateway, internal = new FakeInternal(), reactMaxTurns = 10) {
  const tools = fakeToolDeps();
  return {
    deps: {
      internalClient: internal,
      decryptor: new ModelCredentialDecryptor(KEY_BASE64, 'local-v1'),
      gateway,
      ...tools,
      reactMaxTurns,
    },
    internal,
    toolGateway: tools.toolGateway,
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

  it('user 提示词包含目标、画像与前测摘要，system 提示词允许按需联网', async () => {
    const gateway = new FakeGateway([{ content: planJson() }]);
    const { deps: d } = deps(gateway);

    await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const systemContent = String(gateway.requests[0]?.messages[0]?.content);
    const userContent = String(gateway.requests[0]?.messages[1]?.content);
    expect(systemContent).toContain('你是 LearnCraft 的学习路线规划师。');
    expect(systemContent).toContain('可以调用 tavily_search');
    expect(userContent).toContain('学习主题：Python 函数与类');
    expect(userContent).toContain('学习者水平：beginner');
    expect(userContent).toContain('每周可用分钟：300');
    expect(userContent).toContain('前测得分：42.5');
    expect(userContent).toContain('前测薄弱点摘要：{"functions":"weak","classes":"unknown"}');
  });
});

describe('会话内校验与自纠', () => {
  it('首轮合法：repair_attempts=0、generation_path=model_knowledge、fallback_used=false，摘要 6 键、元数据 5 键', async () => {
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
    expect(result.outputSummary.repair_attempts).toBe(0);
    expect(result.outputSummary.generation_path).toBe('model_knowledge');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);

    const metadata = internal.persisted[0]?.generation_metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      'fallback_used',
      'generation_path',
      'model_id',
      'repair_attempts',
      'tool_call_count',
    ]);
    expect(metadata).toMatchObject({
      model_id: 'deepseek-flash',
      tool_call_count: 0,
      repair_attempts: 0,
      generation_path: 'model_knowledge',
      fallback_used: false,
    });
  });

  it('首轮结构非法（依赖成环）后在同一会话自纠成功：repair_attempts=1、fallback_used=true', async () => {
    const gateway = new FakeGateway([{ content: cyclicPlanJson() }, { content: planJson() }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.repair_attempts).toBe(1);
    expect(result.outputSummary.generation_path).toBe('model_knowledge');
    expect(gateway.requests).toHaveLength(2);

    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual(gateway.requests[0]?.messages[0]);
    expect(messages[1]).toEqual(gateway.requests[0]?.messages[1]);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: cyclicPlanJson() });
    expect(messages[3]?.role).toBe('user');
    expect(String(messages[3]?.content)).toContain('校验失败的字段路径');
    expect((internal.persisted[0]?.generation_metadata as Record<string, unknown>).fallback_used).toBe(true);
  });

  it('会话内宽松规范化仍然生效：旧字段与脏值可在首轮直接通过', async () => {
    const gateway = new FakeGateway([{ content: LOOSE_PLAN_JSON }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.repair_attempts).toBe(0);
    expect(result.outputSummary.generation_path).toBe('model_knowledge');
    expect(gateway.requests).toHaveLength(1);
    const nodes = internal.persisted[0]?.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(6);
    expect(nodes[0]?.node_key).toBe('chapter_1');
  });

  it('模型没有正文时按一次校验失败处理，并给出 response.content_missing 路径', async () => {
    const gateway = new FakeGateway([{ content: null }, { content: planJson() }]);
    const { deps: d } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.repair_attempts).toBe(1);
    const messages = gateway.requests[1]?.messages ?? [];
    expect(String(messages[messages.length - 1]?.content)).toContain('response.content_missing');
  });

  it('节点数不足 6 章时判为校验失败，轮数耗尽后抛 PLAN_MODEL_RECOVERY_INVALID', async () => {
    const gateway = new FakeGateway([{ content: planJson(5) }, { content: planJson(5) }]);
    const { deps: d } = deps(gateway, new FakeInternal(), 2);

    await expect(
      runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'PLAN_MODEL_RECOVERY_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(2);
  });

  it('网关错误直接上抛（交由任务级重试）', async () => {
    const gateway = new FakeGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_503', 'provider 不可用', true) },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_503', retryable: true });
  });
});

describe('联网工具与元数据映射', () => {
  it('模型自主调用 Tavily 且首答即通过：generation_path=model_with_tavily', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"Python 3.13 新特性"}' }] },
      { content: planJson() },
    ]);
    const { deps: d, internal, toolGateway } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(toolGateway.calls).toHaveLength(1);
    const messages = gateway.requests[1]?.messages ?? [];
    const toolMessage = messages[messages.length - 1];
    expect(toolMessage?.role).toBe('tool');
    expect(String(toolMessage?.content)).toContain('"ok":true');
    expect(String(toolMessage?.content)).toContain('TAVILY_SEARCH_EXTRACT_OK');

    expect(result.outputSummary.tool_call_count).toBe(1);
    expect(result.outputSummary.generation_path).toBe('model_with_tavily');
    expect((internal.persisted[0]?.generation_metadata as Record<string, unknown>).fallback_used).toBe(false);
  });

  it('用过联网工具且经过自纠：generation_path=tavily_recovery', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
      { content: cyclicPlanJson() },
      { content: planJson() },
    ]);
    const { deps: d, internal } = deps(gateway);

    const result = await runPlanGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.repair_attempts).toBe(1);
    expect(result.outputSummary.generation_path).toBe('tavily_recovery');
    expect((internal.persisted[0]?.generation_metadata as Record<string, unknown>).fallback_used).toBe(true);
  });

  it('planGenerationPath 的取值集合与语义映射保持稳定', () => {
    expect(planGenerationPath({ toolCallCount: 0, validationFailures: 0 })).toBe('model_knowledge');
    expect(planGenerationPath({ toolCallCount: 0, validationFailures: 2 })).toBe('model_knowledge');
    expect(planGenerationPath({ toolCallCount: 1, validationFailures: 0 })).toBe('model_with_tavily');
    expect(planGenerationPath({ toolCallCount: 1, validationFailures: 1 })).toBe('tavily_recovery');
  });
});
