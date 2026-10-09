/**
 * 独立 LLM Judge 的离线测试。
 *
 * 调用顺序：构造固定评测输入 → 注入假 fetch → 检查 OpenAI 兼容请求 → 校验 1–5 分 JSON；
 * 同时覆盖 Markdown JSON 围栏、超范围分数和加权计算，确保不需要真实 Provider。
 */

import { describe, expect, it } from 'vitest';

import {
  AgentEvalJudgeError,
  buildJudgeMessages,
  createJudgeClient,
  parseJudgeResponse,
} from '../src/evaluation/judge.js';
import { calculateWeightedScore } from '../src/evaluation/runner.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

/** 构造最小合法 Judge 评测用例。 */
function evaluationCase() {
  return {
    case_id: 'judge-001',
    dataset_version: 'v1',
    run_type: 'plan_generate' as const,
    input_snapshot: { goal: { topic: 'TypeScript' } },
    learner_profile: { current_level: 'beginner' },
    reference_facts: ['TypeScript 是 JavaScript 的超集。'],
    required_knowledge_points: ['类型注解'],
    acceptable_answer_points: ['解释类型注解用途。'],
    scoring_rubric: {
      correctness: '事实正确。',
      completeness: '覆盖知识点。',
      relevance: '围绕目标。',
      readability: '清楚易读。',
      teaching_adaptation: '适合初学者。',
    },
    tags: [],
  };
}

/** 构造五维相同分数的 Judge 输出。 */
function scores(score: number) {
  return {
    correctness: { score, reason: '理由', evidence: ['证据'] },
    completeness: { score, reason: '理由', evidence: ['证据'] },
    relevance: { score, reason: '理由', evidence: ['证据'] },
    readability: { score, reason: '理由', evidence: ['证据'] },
    teaching_adaptation: { score, reason: '理由', evidence: ['证据'] },
  };
}

describe('parseJudgeResponse', () => {
  it('解析 OpenAI 响应中的 JSON 围栏并接受 1-5 分', () => {
    expect(parseJudgeResponse({
      choices: [{ message: { content: '```json\n' + JSON.stringify(scores(5)) + '\n```' } }],
    }).correctness.score).toBe(5);
  });

  it('拒绝超范围分数', () => {
    expect(() => parseJudgeResponse({
      choices: [{ message: { content: JSON.stringify(scores(6)) } }],
    })).toThrow(AgentEvalJudgeError);
  });
});

describe('buildJudgeMessages', () => {
  it('按工作流提示词结构生成 Judge 指令并加入 plan 专属检查重点', () => {
    const messages = buildJudgeMessages({ evaluationCase: evaluationCase(), candidateOutput: { nodes: [] } });
    const system = messages[0]?.content ?? '';
    expect(system).toContain('#角色定义');
    expect(system).toContain('#事实边界');
    expect(system).toContain('#场景约束');
    expect(system).toContain('#工作流程');
    expect(system).toContain('#输出规则');
    expect(system).toContain('#示例');
    expect(system).toContain('plan_generate 学习路线');
    expect(messages[1]?.content).toContain('【评测数据开始】');
  });
});

describe('JudgeClient', () => {
  it('发送无工具 JSON 请求并解析返回值', async () => {
    let request: RequestInit | undefined;
    const client = createJudgeClient({
      baseUrl: 'https://judge.example/v1',
      apiKey: 'secret',
      model: 'judge-model',
      temperature: 0,
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(scores(4)) } }],
        }), { status: 200 });
      },
    });
    const result = await client.scoreCandidate({ evaluationCase: evaluationCase(), candidateOutput: { nodes: [] } });
    expect(result.correctness.score).toBe(4);
    expect(request?.method).toBe('POST');
    expect(String(request?.body)).toContain('response_format');
    expect(String(request?.body)).not.toContain(OWNER_ID);
  });
});

describe('calculateWeightedScore', () => {
  it('按 3/2/2/2/1 计算加权分', () => {
    const value = calculateWeightedScore({
      ...scores(1),
      correctness: { score: 5, reason: '理由', evidence: ['证据'] },
    });
    expect(value).toBe(2.2);
  });
});
