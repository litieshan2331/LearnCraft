/**
 * Agent Worker 提交 assessment_generate 结果的内部 Route Handler。
 *
 * 主要职责：校验共享密钥和题集契约，在 Web PostgreSQL 事务中幂等写入 assessments 与 assessment_items。
 */

import { timingSafeEqual } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDatabase } from '@/lib/db/client';
import { agentRuns, assessmentItems, assessments } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

const optionSchema = z.object({
  key: z.string().regex(/^[A-F]$/),
  text: z.string().min(1).max(500),
}).strict();

const questionSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  options: z.array(optionSchema).min(2).max(6),
  answer_key: z.string().regex(/^[A-F]$/),
  explanation: z.string().min(1).max(2_000),
  skill_tags: z.array(z.string().min(1).max(100)).max(10).default([]),
  max_score: z.number().positive().max(100).default(1),
}).strict().superRefine((question, context) => {
  if (!question.options.some((option) => option.key === question.answer_key)) {
    context.addIssue({ code: 'custom', path: ['answer_key'], message: 'answer_key 必须引用已有选项。' });
  }
});

const resultSchema = z.object({
  kind: z.enum(['diagnostic', 'post_test']),
  question_count: z.number().int().min(5).max(20),
  difficulty: z.enum(['normal', 'hard']),
  schema_version: z.literal('assessment.single_choice.v1'),
  plan_id: z.uuid().nullable().optional(),
  questions: z.array(questionSchema).min(5).max(20),
  generation_metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, context) => {
  const validCount = value.kind === 'diagnostic'
    ? value.question_count >= 10 && value.question_count <= 20
    : value.question_count >= 5 && value.question_count <= 10;
  if (!validCount) {
    context.addIssue({ code: 'custom', path: ['question_count'], message: '题目数量不符合该测验类型限制。' });
  }
  if (value.questions.length !== value.question_count) {
    context.addIssue({ code: 'custom', path: ['questions'], message: '题目数组长度必须等于 question_count。' });
  }
  if (value.kind === 'post_test' && !value.plan_id) {
    context.addIssue({ code: 'custom', path: ['plan_id'], message: '后测必须关联 learning plan。' });
  }
});

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const { agentRunId } = await context.params;
  const runId = z.uuid().safeParse(agentRunId);
  if (!runId.success) {
    return NextResponse.json({ error: 'INVALID_AGENT_RUN_ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', field_errors: parsed.error.issues }, { status: 422 });
  }

  const database = getDatabase();
  const persisted = await database.transaction(async (transaction) => {
    const [run] = await transaction
      .select({ ownerId: agentRuns.ownerId, goalId: agentRuns.targetId, runType: agentRuns.runType })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.id, runId.data),
        eq(agentRuns.runType, 'assessment_generate'),
        eq(agentRuns.targetType, 'learning_goal'),
      ))
      .limit(1);
    if (!run) {
      return { kind: 'not_found' as const };
    }

    const [existing] = await transaction
      .select({ id: assessments.id, status: assessments.status, requestedQuestionCount: assessments.requestedQuestionCount })
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, run.ownerId),
        eq(assessments.goalId, run.goalId),
        sql`${assessments.generationMetadata} ->> 'agent_run_id' = ${runId.data}`,
      ))
      .limit(1);
    if (existing) {
      return { kind: 'ok' as const, id: existing.id, status: existing.status, count: existing.requestedQuestionCount ?? parsed.data.question_count };
    }

    const [assessment] = await transaction.insert(assessments).values({
      ownerId: run.ownerId,
      goalId: run.goalId,
      planId: parsed.data.plan_id ?? null,
      kind: parsed.data.kind,
      requestedQuestionCount: parsed.data.question_count,
      difficulty: parsed.data.difficulty,
      status: 'ready',
      schemaVersion: parsed.data.schema_version,
      generationMetadata: { ...parsed.data.generation_metadata, agent_run_id: runId.data },
    }).returning({ id: assessments.id });
    if (!assessment) {
      throw new Error('assessment 插入后未返回记录。');
    }
    await transaction.insert(assessmentItems).values(parsed.data.questions.map((question, index) => ({
      assessmentId: assessment.id,
      ordinal: index + 1,
      itemType: 'single_choice',
      prompt: question.prompt,
      optionsJson: question.options,
      answerKeyJson: { correct_option: question.answer_key },
      gradingMode: 'deterministic',
      rubricJson: {},
      explanation: question.explanation,
      skillTags: question.skill_tags,
      maxScore: String(question.max_score),
      schemaVersion: parsed.data.schema_version,
    })));
    return { kind: 'ok' as const, id: assessment.id, status: 'ready', count: parsed.data.question_count };
  });

  if (persisted.kind === 'not_found') {
    return NextResponse.json({ error: 'AGENT_RUN_NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({ assessment_id: persisted.id, status: persisted.status, question_count: persisted.count });
}

function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get('x-learncraft-internal-secret')?.trim();
  if (!expected || !supplied) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
