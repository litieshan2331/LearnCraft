/**
 * 学习路线 Human-in-the-Loop 的 Worker 合同与 LangGraph 图。
 * 调用顺序：模型生成问题批次 → Zod 校验 → interrupt 暂停 → Command(resume) 恢复并返回结构化答案。
 */

import { Annotation, END, START, StateGraph, interrupt, isGraphInterrupt, Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';

export const HumanReviewOptionSchema = z.object({
  option_id: z.string().min(1).max(100),
  label: z.string().min(1).max(500),
  kind: z.enum(['preset', 'custom_text']),
  input: z.object({
    min_length: z.number().int().min(0).max(2_000),
    max_length: z.number().int().min(1).max(4_000),
  }).nullable(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'custom_text' && value.input === null) {
    context.addIssue({ code: 'custom', path: ['input'], message: '自定义选项必须声明输入边界。' });
  }
  if (value.kind === 'preset' && value.input !== null) {
    context.addIssue({ code: 'custom', path: ['input'], message: '预设选项不能声明自定义输入。' });
  }
});

export const HumanReviewQuestionSchema = z.object({
  question_id: z.string().min(1).max(100),
  prompt: z.string().min(1).max(2_000),
  options: z.array(HumanReviewOptionSchema).length(3),
}).strict().superRefine((value, context) => {
  const optionIds = new Set<string>();
  value.options.forEach((option, index) => {
    if (optionIds.has(option.option_id)) {
      context.addIssue({ code: 'custom', path: ['options', index, 'option_id'], message: '选项 ID 必须唯一。' });
    }
    optionIds.add(option.option_id);
  });
  if (value.options[2]?.kind !== 'custom_text') {
    context.addIssue({ code: 'custom', path: ['options', 2, 'kind'], message: '第三个选项必须为自定义文本。' });
  }
});

export const HumanReviewQuestionBatchSchema = z.object({
  schema_version: z.literal('plan_generation_human_review.v1'),
  review_id: z.uuid(),
  questions: z.array(HumanReviewQuestionSchema).min(1).max(3),
}).strict().superRefine((value, context) => {
  const questionIds = new Set<string>();
  value.questions.forEach((question, index) => {
    if (questionIds.has(question.question_id)) {
      context.addIssue({ code: 'custom', path: ['questions', index, 'question_id'], message: '问题 ID 必须唯一。' });
    }
    questionIds.add(question.question_id);
  });
});

export const HumanReviewAnswerSchema = z.object({
  question_id: z.string().min(1).max(100),
  option_id: z.string().min(1).max(100),
  custom_text: z.string().max(4_000).optional(),
}).strict();

export const HumanReviewAnswerBatchSchema = z.object({
  review_id: z.uuid(),
  answers: z.array(HumanReviewAnswerSchema).min(1).max(3),
}).strict();

export type HumanReviewQuestionBatch = z.infer<typeof HumanReviewQuestionBatchSchema>;
export type HumanReviewAnswer = z.infer<typeof HumanReviewAnswerSchema>;
export type HumanReviewAnswerBatch = z.infer<typeof HumanReviewAnswerBatchSchema>;

export interface PlanHumanReviewPayload extends HumanReviewQuestionBatch {
  thread_id: string;
  graph_version: string;
  expires_at: string;
}

const HumanReviewState = Annotation.Root({
  review: Annotation<HumanReviewQuestionBatch | null>,
  answers: Annotation<HumanReviewAnswer[] | null>,
});

export type PlanHumanReviewState = typeof HumanReviewState.State;

/** 生成并暂停人工确认；恢复时同一节点重放，但只重复读取和问题构造。 */
export function createPlanHumanReviewGraph(input: {
  checkpointer: BaseCheckpointSaver;
  generateQuestions: () => Promise<HumanReviewQuestionBatch>;
}) {
  const graph = new StateGraph(HumanReviewState)
    .addNode('prepare_review', async (state: PlanHumanReviewState) => {
      if (state.review !== null) return {};
      return { review: await input.generateQuestions() };
    })
    .addNode('human_review', async (state: PlanHumanReviewState) => {
      if (state.review === null) throw new Error('人工确认节点缺少已持久化的问题批次。');
      const review = state.review;
      // 不要在 interrupt 周围吞掉 GraphInterrupt；LangGraph 需要它保存当前节点和 payload。
      const answerBatch = interrupt<{ review: HumanReviewQuestionBatch }, HumanReviewAnswerBatch>({
        review,
      });
      const parsed = HumanReviewAnswerBatchSchema.parse(answerBatch);
      if (parsed.review_id !== review.review_id) {
        throw new Error('人工确认答案与当前 review_id 不匹配。');
      }
      return { review, answers: parsed.answers };
    })
    .addEdge(START, 'prepare_review')
    .addEdge('prepare_review', 'human_review')
    .addEdge('human_review', END)
    .compile({ checkpointer: input.checkpointer });

  return graph;
}

export type PlanHumanReviewGraph = ReturnType<typeof createPlanHumanReviewGraph>;

export function isPlanHumanReviewInterrupt(error: unknown): boolean {
  return isGraphInterrupt(error);
}

/** 使用单中断单值协议恢复；未来多中断时由调用方改为按 interrupt ID 映射。 */
export function createPlanHumanReviewResume(answer: HumanReviewAnswerBatch): Command<HumanReviewAnswerBatch, Record<string, never>, 'human_review'> {
  return new Command({ resume: HumanReviewAnswerBatchSchema.parse(answer) });
}
