/**
 * 学习路线人工确认图测试。
 * 调用顺序：构造 MemorySaver 图 → 首次 interrupt → 使用同一 thread_id resume → 校验答案恢复。
 */

import { Command, MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';

import {
  createPlanHumanReviewGraph,
  HumanReviewQuestionBatchSchema,
  isPlanHumanReviewInterrupt,
} from '../src/workflows/plan-generate/human-review.js';

const REVIEW = HumanReviewQuestionBatchSchema.parse({
  schema_version: 'plan_generation_human_review.v1',
  review_id: '11111111-1111-4111-8111-111111111111',
  questions: [{
    question_id: 'pace',
    prompt: '学习节奏？',
    options: [
      { option_id: 'steady', label: '稳定', kind: 'preset', input: null },
      { option_id: 'intensive', label: '强化', kind: 'preset', input: null },
      { option_id: 'custom', label: '自定义', kind: 'custom_text', input: { min_length: 1, max_length: 500 } },
    ],
  }],
});

describe('plan human review graph', () => {
  it('使用同一 thread_id 从 interrupt 恢复', async () => {
    let generateCount = 0;
    const graph = createPlanHumanReviewGraph({
      checkpointer: new MemorySaver(),
      generateQuestions: async () => {
        generateCount += 1;
        return REVIEW;
      },
    });
    const config = { configurable: { thread_id: 'plan_generate:run-1' } };
    let interrupted = false;
    try {
      const first = await graph.invoke({ review: null, answers: null }, config) as unknown as { __interrupt__?: unknown };
      interrupted = Boolean(first.__interrupt__);
    } catch (error) {
      interrupted = isPlanHumanReviewInterrupt(error);
      if (interrupted) expect((error as { interrupts: Array<{ value: unknown }> }).interrupts[0]?.value).toMatchObject({ review: REVIEW });
    }
    expect(interrupted).toBe(true);
    expect((await graph.getState(config)).values.review).toEqual(REVIEW);

    const result = await graph.invoke(new Command({
      resume: { review_id: REVIEW.review_id, answers: [{ question_id: 'pace', option_id: 'steady' }] },
    }), config);
    expect(result.answers).toEqual([{ question_id: 'pace', option_id: 'steady' }]);
    expect(generateCount).toBe(1);
    expect((await graph.getState(config)).next).toEqual([]);
  });
});
