/**
 * 独立 Agent 评测文件契约测试。
 *
 * 调用顺序：构造最小合法评测集、单条结果和汇总报告，再验证评分范围与必需字段校验。
 */

import { describe, expect, it } from 'vitest';

import {
  EvaluationCaseResultSchema,
  EvaluationDatasetSchema,
  EvaluationReportSchema,
} from '../src/evaluation/schema/index.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

/** 构造五维评分规则的最小合法样例。 */
function rubric(): Record<string, string> {
  return {
    correctness: '事实和代码正确。',
    completeness: '覆盖必需知识点。',
    relevance: '围绕当前目标。',
    readability: '结构清楚易读。',
    teaching_adaptation: '符合学习者水平。',
  };
}

/** 构造一个满分维度评分的最小合法样例。 */
function score() {
  return { score: 5, reason: '达到要求。', evidence: ['输出覆盖参考要点。'] };
}

describe('评测集契约', () => {
  it('接受四类工作流的最小评测集', () => {
    const parsed = EvaluationDatasetSchema.parse({
      schema_version: 'agent_eval.dataset.v1',
      dataset_version: 'v1',
      cases: [{
        case_id: 'card-001',
        dataset_version: 'v1',
        run_type: 'card_content_generate',
        input_snapshot: { topic: 'TypeScript' },
        learner_profile: { level: 'beginner' },
        reference_facts: ['TypeScript 是 JavaScript 的超集。'],
        required_knowledge_points: ['类型注解'],
        acceptable_answer_points: ['说明类型注解的作用。'],
        scoring_rubric: rubric(),
        tags: ['normal'],
      }],
    });
    expect(parsed.cases).toHaveLength(1);
  });

  it('允许前测评测用例不提供必测知识点清单', () => {
    const parsed = EvaluationDatasetSchema.parse({
      schema_version: 'agent_eval.dataset.v1',
      dataset_version: 'v1',
      cases: [{
        case_id: 'assessment-001',
        dataset_version: 'v1',
        run_type: 'assessment_generate',
        input_snapshot: { topic: 'TypeScript', question_count: 10, difficulty: 'normal', kind: 'diagnostic' },
        learner_profile: { current_level: 'beginner' },
        reference_facts: ['TypeScript 是 JavaScript 的超集。'],
        acceptable_answer_points: ['解释目标概念。'],
        scoring_rubric: rubric(),
        tags: ['assessment'],
      }],
    });
    expect(parsed.cases[0]?.required_knowledge_points).toEqual([]);
  });

  it('仍要求路线、节点内容和后测评测用例提供必测知识点清单', () => {
    expect(() => EvaluationDatasetSchema.parse({
      schema_version: 'agent_eval.dataset.v1',
      dataset_version: 'v1',
      cases: [{
        case_id: 'plan-001',
        dataset_version: 'v1',
        run_type: 'plan_generate',
        input_snapshot: { goal: { topic: 'TypeScript' } },
        learner_profile: { current_level: 'beginner' },
        reference_facts: ['TypeScript 是 JavaScript 的超集。'],
        acceptable_answer_points: ['路线有完成标准。'],
        scoring_rubric: rubric(),
        tags: ['plan'],
      }],
    })).toThrow();
  });
});

describe('评测结果契约', () => {
  it('接受 1-5 分的完整单条结果', () => {
    const parsed = EvaluationCaseResultSchema.parse({
      schema_version: 'agent_eval.case_result.v1',
      run_id: 'run-001',
      case_id: 'card-001',
      owner_id: OWNER_ID,
      run_type: 'card_content_generate',
      business_model: { connection_id: 'connection-001', model_id: 'model-a' },
      judge_model: 'judge-a',
      candidate_output: { foundation: '内容' },
      structure_check: { passed: true, errors: [] },
      scores: {
        correctness: score(),
        completeness: score(),
        relevance: score(),
        readability: score(),
        teaching_adaptation: score(),
      },
      weighted_score: 5,
      percentage_score: 100,
      status: 'scored',
      error: null,
      started_at: '2026-10-08T00:00:00.000Z',
      finished_at: '2026-10-08T00:00:01.000Z',
    });
    expect(parsed.scores?.correctness.score).toBe(5);
  });

  it('拒绝超出 1-5 的 Judge 分数', () => {
    const invalid = {
      score: 6,
      reason: '超出范围。',
      evidence: [],
    };
    expect(() => EvaluationCaseResultSchema.shape.scores.unwrap().parse({
      correctness: invalid,
      completeness: score(),
      relevance: score(),
      readability: score(),
      teaching_adaptation: score(),
    })).toThrow();
  });
});

describe('汇总报告契约', () => {
  it('接受带五维平均分和加权分的报告', () => {
    const parsed = EvaluationReportSchema.parse({
      schema_version: 'agent_eval.report.v1',
      run_id: 'run-001',
      owner_id: OWNER_ID,
      dataset_version: 'v1',
      judge_model: 'judge-a',
      total_cases: 1,
      scored_cases: 1,
      invalid_cases: 0,
      failed_cases: 0,
      dimension_averages: {
        correctness: 5,
        completeness: 4,
        relevance: 4,
        readability: 4,
        teaching_adaptation: 3,
      },
      weighted_average: 4.2,
      percentage_average: 84,
      cases: [{ case_id: 'card-001', status: 'scored', weighted_score: 4.2, percentage_score: 84 }],
      started_at: '2026-10-08T00:00:00.000Z',
      finished_at: '2026-10-08T00:00:01.000Z',
    });
    expect(parsed.weighted_average).toBe(4.2);
  });
});
