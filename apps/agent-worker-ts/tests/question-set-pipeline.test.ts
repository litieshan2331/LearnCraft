/**
 * 题集管线（question-set-pipeline）的单元测试。
 *
 * 重点固化三阶段的工具开放范围（Python 的 repair_with_tavily / final_with_tavily）、
 * 工具调用数只在成功阶段累加、无工具阶段的 response.content_missing 判定，
 * 以及全部失败时的错误取舍规则。工具循环的细节由 tool-aware-generator 的单测覆盖。
 */
import { describe, expect, it } from 'vitest';

import { FakeToolGateway } from './helpers/fake-tool-gateway.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
} from '../src/infrastructure/llm/model-gateway.js';
import {
  QUESTION_SET_STAGES,
  runQuestionSetStages,
  searchExtractLabel,
} from '../src/workflows/question-set-pipeline.js';

const CONNECTION = {
  ownerId: '11111111-2222-4333-8444-555555555555',
  connectionId: '66666666-7777-4888-8999-000000000000',
  baseUrl: 'https://api.example.com',
  modelId: 'deepseek-flash',
  apiKey: 'sk-test',
};

function question(index: number): Record<string, unknown> {
  return {
    prompt: '第 ' + String(index) + ' 题',
    options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
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

type Step = { content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> } | { error: ModelGatewayError };

function scriptedComplete(script: Step[], requests: ModelCompletionRequest[]) {
  return async (request: ModelCompletionRequest): Promise<ModelCompletionResponse> => {
    requests.push(request);
    const step = script.shift();
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
  };
}

function baseInput(script: Step[], config: { repairWithTavily: boolean; finalWithTavily: boolean }) {
  const requests: ModelCompletionRequest[] = [];
  return {
    requests,
    input: {
      complete: scriptedComplete(script, requests),
      toolGateway: new FakeToolGateway(),
      maxToolCalls: 3,
      runId: 'run-1',
      connection: CONNECTION,
      baseMessages: [
        { role: 'system' as const, content: 'system' },
        { role: 'user' as const, content: 'user' },
      ],
      expectedQuestionCount: 5,
      repairInstruction: '修复指令',
      finalInstruction: '最终恢复指令',
      stageConfig: config,
    },
  };
}

describe('阶段与工具开放范围', () => {
  it('阶段顺序与 Python 一致，且按配置决定修复与最终阶段是否开放工具', async () => {
    expect(QUESTION_SET_STAGES).toEqual(['initial', 'repair', 'tavily_recovery']);

    const { input, requests } = baseInput(
      [{ content: '{}' }, { content: '{}' }, { content: questionSetJson() }],
      { repairWithTavily: false, finalWithTavily: true },
    );
    const outcome = await runQuestionSetStages(input);

    expect(outcome.recoveryStage).toBe('tavily_recovery');
    expect(requests.map((request) => request.tools?.map((tool) => tool.name) ?? null)).toEqual([
      ['tavily_search'],
      null,
      ['tavily_search'],
    ]);
    // 最终恢复阶段使用 final 指令。
    expect(String(requests[2]?.messages[3]?.content)).toBe('最终恢复指令');
  });

  it('两个开关都为真时修复阶段同样开放工具', async () => {
    const { input, requests } = baseInput(
      [{ content: '{}' }, { content: questionSetJson() }],
      { repairWithTavily: true, finalWithTavily: true },
    );
    const outcome = await runQuestionSetStages(input);

    expect(outcome.recoveryStage).toBe('repair');
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['tavily_search']);
    expect(String(requests[1]?.messages[3]?.content)).toBe('修复指令');
  });

  it('search_extract 由工具调用数决定', () => {
    expect(searchExtractLabel(0)).toBe('not_used');
    expect(searchExtractLabel(2)).toBe('tavily_search_then_extract');
  });
});

describe('失败取舍', () => {
  it('无工具阶段返回工具调用而无正文时按 response.content_missing 处理', async () => {
    const { input } = baseInput(
      [
        { content: '{}' },
        { content: null, toolCalls: [{ id: 'c1', name: 'tavily_search', argumentsJson: '{}' }] },
        { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_500', '服务端错误', true) },
      ],
      { repairWithTavily: false, finalWithTavily: false },
    );

    await expect(runQuestionSetStages(input)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_HTTP_500',
    });
  });

  it('全部阶段都是结构失败时汇总前 8 条校验路径', async () => {
    const { input } = baseInput(
      [{ content: '{}' }, { content: '{}' }, { content: '{}' }],
      { repairWithTavily: false, finalWithTavily: false },
    );

    await expect(runQuestionSetStages(input)).rejects.toMatchObject({
      code: 'MODEL_STRUCTURED_OUTPUT_INVALID',
      retryable: false,
    });
  });

  it('最后一个错误是非结构错误时原样上抛', async () => {
    const { input } = baseInput(
      [
        { content: '{}' },
        { content: '{}' },
        { error: new ModelGatewayError('MODEL_PROVIDER_HTTP_429', '限流', true) },
      ],
      { repairWithTavily: false, finalWithTavily: false },
    );

    await expect(runQuestionSetStages(input)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_HTTP_429',
      retryable: true,
    });
  });
});

describe('工具调用计数', () => {
  it('只统计成功阶段的工具调用数', async () => {
    const { input } = baseInput([{ content: '{}' }, { content: '{}' }, { content: questionSetJson() }], {
      repairWithTavily: false,
      finalWithTavily: true,
    });
    const outcome = await runQuestionSetStages(input);

    expect(outcome.toolCallCount).toBe(0);
  });
});
