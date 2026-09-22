/**
 * card_content_generate 工作流的等价性测试（使用假内部接口与假网关，不发真实请求）。
 *
 * 重点固化改造后的单会话 ReAct 行为与保持不变的对外契约：输入契约（agent_role、session key、
 * plan_node.id）、首轮宽松输出的规范化、自纠反馈携带字段路径、4 键输出摘要与 3 键元数据，
 * 以及跨轮次真实 token 用量的累加。
 */
import { encryptCredential } from '@learncraft/security-primitives';
import { describe, expect, it } from 'vitest';

import { ModelGatewayError, type ModelCompletionRequest, type ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import { fakeToolDeps } from './helpers/fake-tool-gateway.js';
import type {
  DefaultModelConnectionEnvelope,
  PersistedCardContentEnvelope,
} from '../src/schemas/core-internal.js';
import {
  runCardContentGenerate,
  type CardContentInternalPort,
  type CardContentModelGatewayPort,
} from '../src/workflows/card-content-generate/index.js';

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

/** 旧字段名构成的宽松输出，用于验证「每次解析都会先规范化」（v2：files 一个文件一个元素）。 */
const LOOSE_DOCUMENT_JSON = JSON.stringify({
  summary: '由旧字段构成的基础内容。',
  example: {
    description: '示例说明',
    files: [{ file: 'src/a.ts', lang: 'typescript', code: 'export const a = 1;' }],
    entry: 'src/a.ts',
    steps: [{ file: 'src/a.ts', fn: 'a', description: '调用 a' }],
    output: '1',
  },
  common_mistakes: [{ title: '误区', cause: '原因', fix: '修复' }],
  references: [{ url: 'https://example.com', title: '资料' }],
  teaching_memory: { concepts: ['概念'], mistakes: ['错误'], targets: ['目标'] },
});

/** 结构合同可解析但内层字段非法的输出（pitfalls_debug 字段名错误），用于验证字段路径回灌。 */
const INVALID_PITFALLS_JSON = JSON.stringify({
  schema_version: 'card_content.v2',
  foundation: '基础内容。',
  worked_example: {
    explanation: '说明',
    files: [{ path: 'src/a.ts', language: 'ts', role: 'entry', content: 'export const a = 1;' }],
    entry_file: 'src/a.ts',
    call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: '准备' }],
    expected_output: 'src/a.ts › a：1',
  },
  pitfalls_debug: [{ title: '误区', reason: '原因写错字段名', fix: '修复' }],
  source_refs: [],
  teaching_memory: { key_concepts: ['概念'], common_mistakes: [], assessment_targets: ['目标'] },
});

const VALID_DOCUMENT_JSON = JSON.stringify({
  schema_version: 'card_content.v2',
  foundation: '基础内容。',
  worked_example: {
    explanation: '说明',
    files: [{ path: 'src/a.ts', language: 'ts', role: 'entry', content: 'export const a = 1;' }],
    entry_file: 'src/a.ts',
    call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: '准备' }],
    expected_output: 'src/a.ts › a：1',
  },
  pitfalls_debug: [{ title: '误区', cause: '原因', fix: '修复' }],
  source_refs: [],
  teaching_memory: { key_concepts: ['概念'], common_mistakes: [], assessment_targets: ['目标'] },
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

function deps(gateway: FakeGateway, internal = new FakeInternal(), reactMaxTurns = 5) {
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

  it('user 提示词包含主题、水平与章节信息，system 提示词允许按需联网', async () => {
    const gateway = new FakeGateway([{ content: LOOSE_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const systemContent = String(gateway.requests[0]?.messages[0]?.content);
    const userContent = String(gateway.requests[0]?.messages[1]?.content);
    expect(systemContent).toContain('你是 LearnCraft 的 Node Tutor。');
    expect(systemContent).toContain('可以调用 tavily_search');
    expect(userContent).toContain('学习主题：Python 函数');
    expect(userContent).toContain('学习者水平：beginner');
    expect(userContent).toContain('章节标题：函数与参数');
    expect(userContent).toContain('完成标准：["能写出发起调用的函数"]');
  });
});

describe('单会话 ReAct 行为', () => {
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
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(gateway.requests).toHaveLength(1);

    const payload = internal.persisted[0];
    expect(Object.keys(payload?.generation_metadata as Record<string, unknown>).sort()).toEqual([
      'logical_session_key',
      'model_id',
      'tool_call_count',
    ]);
    expect(payload?.plan_node_id).toBe(PLAN_NODE_ID);
    expect(payload?.schema_version).toBe('card_content.v2');
  });

  it('首轮不可解析时在同一会话追加反馈后自纠，消息列表不重建', async () => {
    const gateway = new FakeGateway([{ content: INVALID_PITFALLS_JSON }, { content: VALID_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(gateway.requests).toHaveLength(2);
    const messages = gateway.requests[1]?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual(gateway.requests[0]?.messages[0]);
    expect(messages[1]).toEqual(gateway.requests[0]?.messages[1]);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: INVALID_PITFALLS_JSON });
    expect(messages[3]?.role).toBe('user');
    const feedback = String(messages[3]?.content);
    // pitfalls_debug 的字段名错误会被规范化器指出具体路径。
    expect(feedback).toContain('pitfalls_debug');
  });

  it('模型没有正文时按一次校验失败处理，并给出 response.content_missing 路径', async () => {
    const gateway = new FakeGateway([{ content: null }, { content: VALID_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    const messages = gateway.requests[1]?.messages ?? [];
    expect(String(messages[messages.length - 1]?.content)).toContain('response.content_missing');
  });

  it('模型自主调用 Tavily：工具全程开放，真实 tool_call_count 写入元数据', async () => {
    const gateway = new FakeGateway([
      { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{"query":"Python 装饰器"}' }] },
      { content: VALID_DOCUMENT_JSON },
    ]);
    const { deps: d, internal, toolGateway } = deps(gateway);

    const result = await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(toolGateway.calls).toHaveLength(1);
    for (const request of gateway.requests) {
      expect(request.tools?.map((tool) => tool.name)).toEqual(['tavily_search']);
    }
    expect(result.outputSummary.tool_call_count).toBe(1);
    expect(internal.persisted[0]?.generation_metadata).toMatchObject({ tool_call_count: 1 });
  });

  it('跨轮次的 token 用量按真实值累加', async () => {
    const gateway = new FakeGateway([{ content: '不是 JSON' }, { content: VALID_DOCUMENT_JSON }]);
    const { deps: d } = deps(gateway);

    const result = await runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d);

    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 44 });
  });

  it('轮数耗尽时抛 CARD_CONTENT_OUTPUT_INVALID 并附带校验路径', async () => {
    const gateway = new FakeGateway([
      { content: INVALID_PITFALLS_JSON },
      { content: INVALID_PITFALLS_JSON },
    ]);
    const { deps: d } = deps(gateway, new FakeInternal(), 2);

    await expect(
      runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'CARD_CONTENT_OUTPUT_INVALID', retryable: false });
    expect(gateway.requests).toHaveLength(2);
  });

  it('网关错误直接上抛（交由任务级重试）', async () => {
    const gateway = new FakeGateway([
      { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', 'provider 内部错误', true) },
    ]);
    const { deps: d } = deps(gateway);

    await expect(
      runCardContentGenerate({ runId: 'run-1', inputSummaryJson: INPUT_SUMMARY }, d),
    ).rejects.toMatchObject({ code: 'MODEL_PROVIDER_HTTP_500', retryable: true });
  });
});
