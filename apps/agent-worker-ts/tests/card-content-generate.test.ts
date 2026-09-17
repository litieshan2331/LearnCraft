/**
 * card_content_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化与 Python（card_content_generate.py）逐项对齐的行为：输入契约（agent_role、session key、
 * plan_node.id）、首轮宽松输出的规范化、一次无工具修复的消息顺序与文案、修复失败后进入无资料兜底、
 * 4 键输出摘要与 3 键元数据，以及跨阶段真实 token 用量的累加。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import type {
  DefaultModelConnectionEnvelope,
  PersistedCardContentEnvelope,
} from '../src/schemas/core-internal.js';
import {
  runCardContentGenerate,
  type CardContentInternalPort,
  type CardContentModelGatewayPort,
} from '../src/workflows/card-content-generate.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const CONNECTION_ID = '66666666-7777-4888-8999-000000000000';
const CARD_CONTENT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PLAN_NODE_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

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

/** 旧字段名构成的宽松输出，用于验证「每次解析都会先规范化」。 */
const LOOSE_DOCUMENT_JSON = JSON.stringify({
  summary: '由旧字段构成的基础内容。',
  example: { description: '示例说明', snippet: 'print(2)', steps: ['准备', '执行'], output: '2' },
  common_mistakes: [{ title: '误区', cause: '原因', fix: '修复' }],
  references: [{ url: 'https://example.com', title: '资料' }],
  teaching_memory: { concepts: ['概念'], mistakes: ['错误'], targets: ['目标'] },
});

const INPUT_SUMMARY = {
  agent_role: 'node_tutor',
  logical_session_key: 'node:' + PLAN_NODE_ID,
  goal: { topic: 'Python 函数', desired_outcome: '能用函数组织代码' },
  learner_profile: { current_level: 'beginner' },
  learning_plan: { title: 'Python 路线' },
  plan_node: {
    id: PLAN_NODE_ID,
    title: '函数与参数',
    node_brief: '理解函数定义与参数传递。',
    learning_objective: '能定义带参数的函数',
    completion_criteria: ['能写出发起调用的函数'],
  },
};

class FakeInternal implements CardContentInternalPort {
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

  async persistCardContent(_agentRunId: string, payload: Record<string, unknown>): Promise<PersistedCardContentEnvelope> {
    this.persisted.push(payload);
    return { card_content_id: CARD_CONTENT_ID, status: 'ready' };
  }
}

type Step = { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> } | { error: ModelGatewayError };

class FakeGateway implements CardContentModelGatewayPort {
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
  it('agent_role 必须是 node_tutor，plan_node.id 必须存在', async () => {
    const gateway = new FakeGateway([{ content: LOOSE_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    await expect(
      runCardContentGenerate(
        { runId: 'run-1', inputSummaryJson: { ...INPUT_SUMMARY, agent_role: 'planner' } },
        d,
      ),
    ).rejects.toMatchObject({ code: 'CARD_CONTENT_INPUT_INVALID', retryable: false });

    const { plan_node: node, ...withoutNode } = INPUT_SUMMARY;
    await expect(
      runCardContentGenerate(
        {
          runId: 'run-1',
          inputSummaryJson: { ...withoutNode, plan_node: { title: node.title } },
        },
        d,
      ),
    ).rejects.toMatchObject({ code: 'CARD_CONTENT_INPUT_INVALID' });
    expect(gateway.requests).toHaveLength(0);
  });

  it('user 提示词包含主题、水平与章节信息，system 不含联网工具描述', async () => {
    const gateway = new FakeGateway([{ content: LOOSE_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const systemContent = String(gateway.requests[0]?.messages[0]?.content);
    const userContent = String(gateway.requests[0]?.messages[1]?.content);
    expect(systemContent).toContain('你是 LearnCraft 的 Node Tutor。');
    expect(systemContent).toContain('本次不提供任何联网检索工具');
    expect(userContent).toContain('学习主题：Python 函数');
    expect(userContent).toContain('学习者水平：beginner');
    expect(userContent).toContain('章节标题：函数与参数');
    expect(userContent).toContain('完成标准：["能写出发起调用的函数"]');
  });
});

describe('解析与修复', () => {
  it('首轮宽松输出被规范化后落库：摘要 4 键、元数据 3 键', async () => {
    const gateway = new FakeGateway([{ content: LOOSE_DOCUMENT_JSON }]);
    const { deps: d, internal } = deps(gateway);

    const result = await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(Object.keys(result.outputSummary).sort()).toEqual([
      'card_content_id',
      'model_id',
      'plan_node_id',
      'tool_call_count',
    ]);
    expect(result.outputSummary).toMatchObject({
      card_content_id: CARD_CONTENT_ID,
      plan_node_id: PLAN_NODE_ID,
      tool_call_count: 0,
      model_id: 'deepseek-flash',
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);

    const payload = internal.persisted[0];
    expect(payload?.plan_node_id).toBe(PLAN_NODE_ID);
    expect(payload?.schema_version).toBe('card_content.v1');
    expect(payload?.foundation).toBe('由旧字段构成的基础内容。');
    expect(payload?.teaching_memory).toEqual({
      key_concepts: ['概念'],
      common_mistakes: ['错误'],
      assessment_targets: ['目标'],
    });
    expect(payload?.generation_metadata).toEqual({
      model_id: 'deepseek-flash',
      tool_call_count: 0,
      logical_session_key: 'node:' + PLAN_NODE_ID,
    });
  });

  it('首轮不可解析时执行一次无工具修复，消息顺序与文案与 Python 一致', async () => {
    const firstOutput = '不是 JSON';
    const gateway = new FakeGateway([{ content: firstOutput }, { content: LOOSE_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    const result = await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });
    const repairMessages = gateway.requests[1]?.messages ?? [];
    expect(repairMessages).toHaveLength(4);
    expect(repairMessages[2]).toMatchObject({ role: 'assistant', content: firstOutput });
    expect(repairMessages[3]?.role).toBe('system');
    expect(String(repairMessages[3]?.content)).toContain('上一轮节点内容不符合 card_content.v1');
  });

  it('首轮无正文时抛 MODEL_PROVIDER_RESPONSE_INVALID，不进入修复', async () => {
    const gateway = new FakeGateway([{ content: null }]);
    const { deps: d } = deps(gateway);

    await expect(
      runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_RESPONSE_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(1);
  });
});

describe('兜底重建', () => {
  it('修复失败后进入无资料兜底，并在提示词中携带固定的联网错误类别', async () => {
    const gateway = new FakeGateway([
      { content: '不是 JSON' },
      { content: '仍不是 JSON' },
      { content: LOOSE_DOCUMENT_JSON },
    ]);
    const { deps: d, internal } = deps(gateway);

    const result = await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.outputSummary.card_content_id).toBe(CARD_CONTENT_ID);
    expect(gateway.requests).toHaveLength(3);

    const recoverySystem = String(gateway.requests[2]?.messages[0]?.content);
    const recoveryUser = String(gateway.requests[2]?.messages[1]?.content);
    expect(recoverySystem).toContain('联网资料不可用，请仅使用你已有的稳定知识生成节点内容。');
    expect(recoveryUser).toContain('节点：函数与参数');
    expect(recoveryUser).toContain('联网工具错误类别：TAVILY_TOOL_NOT_AVAILABLE');
    expect(internal.persisted).toHaveLength(1);
  });

  it('兜底结果仍不符合合同时抛 CARD_CONTENT_MODEL_RECOVERY_INVALID', async () => {
    const gateway = new FakeGateway([
      { content: '不是 JSON' },
      { content: '仍不是 JSON' },
      { content: '{"pitfalls_debug": []}' },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({
      code: 'CARD_CONTENT_MODEL_RECOVERY_INVALID',
      message: '无资料模型恢复结果仍不符合节点内容合同（联网错误类别：TAVILY_TOOL_NOT_AVAILABLE）。',
      retryable: false,
    });
  });

  it('兜底阶段模型没有正文时同样映射为恢复失败', async () => {
    const gateway = new FakeGateway([
      { content: '不是 JSON' },
      { content: '仍不是 JSON' },
      { content: null },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'CARD_CONTENT_MODEL_RECOVERY_INVALID' });
  });
});
