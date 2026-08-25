/**
 * Agent Worker 提交前测或节点后测结果的内部 Route Handler。
 *
 * 主要职责：校验共享密钥和题集契约，按 AgentRun 类型验证目标范围，并在 Web PostgreSQL 事务中幂等写入 assessments 与 assessment_items。
 */

import { timingSafeEqual } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import {
  agentRuns,
  assessmentItems,
  assessments,
  cardContents,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    context.addIssue({ code: "custom", path: ["answer_key"], message: "answer_key 必须引用已有选项。" });
  }
});

const resultSchema = z.object({
  kind: z.enum(["diagnostic", "post_test"]),
  question_count: z.number().int().min(5).max(20),
  difficulty: z.enum(["normal", "hard"]),
  schema_version: z.literal("assessment.single_choice.v1"),
  plan_id: z.uuid().nullable().optional(),
  plan_node_id: z.uuid().nullable().optional(),
  source_card_content_id: z.uuid().nullable().optional(),
  questions: z.array(questionSchema).min(5).max(20),
  generation_metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, context) => {
  const validCount = value.kind === "diagnostic"
    ? value.question_count >= 10 && value.question_count <= 20
    : value.question_count >= 5 && value.question_count <= 10;

  if (!validCount) {
    context.addIssue({ code: "custom", path: ["question_count"], message: "题目数量不符合该测验类型限制。" });
  }
  if (value.questions.length !== value.question_count) {
    context.addIssue({ code: "custom", path: ["questions"], message: "题目数组长度必须等于 question_count。" });
  }

  if (value.kind === "diagnostic") {
    if (value.plan_id || value.plan_node_id || value.source_card_content_id) {
      context.addIssue({ code: "custom", path: ["kind"], message: "前测不能关联路线、节点或节点内容。" });
    }
    return;
  }

  if (!value.plan_node_id || !value.source_card_content_id || value.plan_id) {
    context.addIssue({ code: "custom", path: ["plan_node_id"], message: "节点后测必须绑定 plan_node_id 和 source_card_content_id，且不能绑定 learning_plan。" });
  }
});

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { agentRunId } = await context.params;
  const runId = z.uuid().safeParse(agentRunId);
  if (!runId.success) {
    return NextResponse.json({ error: "INVALID_AGENT_RUN_ID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", field_errors: parsed.error.issues }, { status: 422 });
  }

  const database = getDatabase();
  const persisted = await database.transaction(async (transaction) => {
    const [run] = await transaction
      .select({
        ownerId: agentRuns.ownerId,
        goalId: agentRuns.goalId,
        targetId: agentRuns.targetId,
        targetType: agentRuns.targetType,
        runType: agentRuns.runType,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId.data))
      .limit(1);

    if (!run) {
      return { kind: "not_found" as const };
    }

    const isPretest = run.runType === "assessment_generate"
      && run.targetType === "learning_goal";
    const isPosttest = run.runType === "posttest_generate"
      && run.targetType === "plan_node";

    if (!isPretest && !isPosttest) {
      return { kind: "not_found" as const };
    }

    if (isPretest && parsed.data.kind !== "diagnostic") {
      return { kind: "contract_mismatch" as const };
    }
    if (isPosttest && (
      parsed.data.kind !== "post_test"
      || parsed.data.plan_node_id !== run.targetId
      || !parsed.data.source_card_content_id
    )) {
      return { kind: "contract_mismatch" as const };
    }

    if (isPosttest) {
      const [sourceContent] = await transaction
        .select({ id: cardContents.id })
        .from(cardContents)
        .where(and(
          eq(cardContents.id, parsed.data.source_card_content_id!),
          eq(cardContents.planNodeId, run.targetId),
          eq(cardContents.ownerId, run.ownerId),
          eq(cardContents.status, "ready"),
        ))
        .limit(1);

      if (!sourceContent) {
        return { kind: "source_content_not_found" as const };
      }
    }

    const [existing] = await transaction
      .select({
        id: assessments.id,
        status: assessments.status,
        requestedQuestionCount: assessments.requestedQuestionCount,
      })
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, run.ownerId),
        eq(assessments.goalId, run.goalId),
sql`${assessments.generationMetadata} ->> 'agent_run_id' = ${runId.data}`,
      ))
      .limit(1);

    if (existing) {
      return {
        kind: "ok" as const,
        id: existing.id,
        status: existing.status,
        count: existing.requestedQuestionCount ?? parsed.data.question_count,
      };
    }

    const [assessment] = await transaction.insert(assessments).values({
      ownerId: run.ownerId,
      goalId: run.goalId,
      planId: null,
      planNodeId: parsed.data.plan_node_id ?? null,
      sourceCardContentId: parsed.data.source_card_content_id ?? null,
      kind: parsed.data.kind,
      requestedQuestionCount: parsed.data.question_count,
      difficulty: parsed.data.difficulty,
      status: "ready",
      schemaVersion: parsed.data.schema_version,
      generationMetadata: { ...parsed.data.generation_metadata, agent_run_id: runId.data },
    }).returning({ id: assessments.id });

    if (!assessment) {
      throw new Error("assessment 插入后未返回记录。");
    }

    await transaction.insert(assessmentItems).values(parsed.data.questions.map((question, index) => ({
      assessmentId: assessment.id,
      ordinal: index + 1,
      itemType: "single_choice",
      prompt: question.prompt,
      optionsJson: question.options,
      answerKeyJson: { correct_option: question.answer_key },
      gradingMode: "deterministic",
      rubricJson: {},
      explanation: question.explanation,
      skillTags: question.skill_tags,
      maxScore: String(question.max_score),
      schemaVersion: parsed.data.schema_version,
    })));

    return {
      kind: "ok" as const,
      id: assessment.id,
      status: "ready",
      count: parsed.data.question_count,
    };
  });

  if (persisted.kind === "not_found") {
    return NextResponse.json({ error: "AGENT_RUN_NOT_FOUND" }, { status: 404 });
  }
  if (persisted.kind === "contract_mismatch") {
    return NextResponse.json({ error: "AGENT_RUN_RESULT_CONTRACT_MISMATCH" }, { status: 422 });
  }
  if (persisted.kind === "source_content_not_found") {
    return NextResponse.json({ error: "SOURCE_CARD_CONTENT_NOT_FOUND" }, { status: 422 });
  }

  return NextResponse.json({
    assessment_id: persisted.id,
    status: persisted.status,
    question_count: persisted.count,
  });
}

function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}