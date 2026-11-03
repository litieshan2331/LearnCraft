/**
 * 学习路线 Human-in-the-Loop 答案提交 Route Handler。
 * 调用顺序：Session 鉴权 → AgentRun/人工确认行锁 → 校验 review 与答案 → 写入答案并重排同一 AgentRun。
 */

import { and, eq, max } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { agentHumanReviews, agentRunEvents, agentRuns, outboxEvents } from "@/lib/db/schema";
import { applyAgentRunSessionRenewal, authenticateAgentRunRequest, agentRunPathSchema } from "@/modules/agent-run/interfaces/agent-run-http";
import {
  HumanReviewAnswerSchema,
  HumanReviewQuestionBatchSchema,
} from "@/modules/agent-run/domain/human-review";
import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

const answerRequestSchema = z.object({
  review_id: z.uuid(),
  answers: z.array(HumanReviewAnswerSchema).min(1).max(3),
}).strict();

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const authentication = await authenticateAgentRunRequest(request);
  if (!authentication.authenticated) return authentication.response;

  const routeParams = await context.params;
  // Next.js 动态路由使用 agentRunId；领域 schema 使用 snake_case，必须在边界处显式映射。
  const params = agentRunPathSchema.safeParse({ agent_run_id: routeParams.agentRunId });
  if (!params.success) {
    return applyAgentRunSessionRenewal(apiErrorResponse(400, "INVALID_AGENT_RUN_ID", "任务编号不合法。"), authentication);
  }

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (idempotencyKey.length === 0 || idempotencyKey.length > 255) {
    return applyAgentRunSessionRenewal(apiErrorResponse(400, "IDEMPOTENCY_KEY_REQUIRED", "请提供有效的 Idempotency-Key。"), authentication);
  }

  const body = await request.json().catch(() => null);
  const parsed = answerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return applyAgentRunSessionRenewal(apiErrorResponse(422, "HUMAN_REVIEW_ANSWER_INVALID", "人工确认答案格式不合法。"), authentication);
  }

  const database = getDatabase();
  try {
    const result = await database.transaction(async (transaction) => {
      const [run] = await transaction.select({
        id: agentRuns.id,
        ownerId: agentRuns.ownerId,
        runType: agentRuns.runType,
        targetType: agentRuns.targetType,
        targetId: agentRuns.targetId,
        goalId: agentRuns.goalId,
        status: agentRuns.status,
        traceId: agentRuns.traceId,
      }).from(agentRuns).where(and(
        eq(agentRuns.id, params.data.agent_run_id),
        eq(agentRuns.ownerId, authentication.ownerId),
      )).limit(1).for("update");

      const [review] = await transaction.select().from(agentHumanReviews).where(
        eq(agentHumanReviews.agentRunId, params.data.agent_run_id),
      ).limit(1).for("update");

      if (!run || !review || run.runType !== "plan_generate" || run.targetType !== "learning_goal" || run.targetId !== run.goalId) {
        return { kind: "not_found" as const };
      }

      if (review.idempotencyKey === idempotencyKey && review.status === "submitted") {
        return { kind: "already_submitted" as const, runId: run.id, reviewId: review.id };
      }
      if (review.status !== "waiting" || run.status !== "waiting_for_human") {
        return { kind: "state_conflict" as const };
      }
      if (parsed.data.review_id !== review.id) {
        return { kind: "answer_invalid" as const };
      }
      if (review.idempotencyKey !== null && review.idempotencyKey !== idempotencyKey) {
        return { kind: "idempotency_conflict" as const };
      }
      if (review.expiresAt !== null && review.expiresAt.getTime() <= Date.now()) {
        await transaction.update(agentHumanReviews).set({ status: "expired", updatedAt: new Date() }).where(eq(agentHumanReviews.id, review.id));
        await transaction.update(agentRuns).set({ status: "expired", finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, run.id));
        return { kind: "expired" as const };
      }

      const questions = HumanReviewQuestionBatchSchema.parse(review.questionsJson);
      const questionMap = new Map(questions.questions.map((question) => [question.question_id, question]));
      const seenQuestionIds = new Set<string>();
      for (const answer of parsed.data.answers) {
        if (seenQuestionIds.has(answer.question_id)) return { kind: "answer_invalid" as const };
        seenQuestionIds.add(answer.question_id);
        const question = questionMap.get(answer.question_id);
        const option = question?.options.find((item) => item.option_id === answer.option_id);
        if (!question || !option) return { kind: "answer_invalid" as const };
        if (option.kind === "custom_text") {
          const text = answer.custom_text ?? "";
          if (option.input === null || text.length < option.input.min_length || text.length > option.input.max_length) {
            return { kind: "answer_invalid" as const };
          }
        } else if (answer.custom_text !== undefined) {
          return { kind: "answer_invalid" as const };
        }
      }
      if (seenQuestionIds.size !== questions.questions.length) return { kind: "answer_invalid" as const };

      const now = new Date();
      await transaction.update(agentHumanReviews).set({
        answersJson: parsed.data.answers,
        status: "submitted",
        idempotencyKey,
        submittedAt: now,
        updatedAt: now,
      }).where(eq(agentHumanReviews.id, review.id));
      await transaction.update(agentRuns).set({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      }).where(eq(agentRuns.id, run.id));

      const [lastEvent] = await transaction.select({ sequenceNo: max(agentRunEvents.sequenceNo) })
        .from(agentRunEvents).where(eq(agentRunEvents.agentRunId, run.id));
      await transaction.insert(agentRunEvents).values({
        agentRunId: run.id,
        sequenceNo: (lastEvent?.sequenceNo ?? 0) + 1,
        eventType: "run.human_review_submitted",
        payloadJson: { review_id: review.id },
        occurredAt: now,
      });
      await transaction.insert(outboxEvents).values({
        aggregateType: "agent_run",
        aggregateId: run.id,
        eventType: "agent.run.requested",
        eventVersion: 1,
        payloadJson: { agent_run_id: run.id, trace_id: run.traceId, task_version: 1 },
        traceId: run.traceId,
      });
      return { kind: "submitted" as const, runId: run.id, reviewId: review.id };
    });

    if (result.kind === "not_found") return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), authentication);
    if (result.kind === "already_submitted") return applyAgentRunSessionRenewal(NextResponse.json({ id: result.runId, status: "queued", review_id: result.reviewId }), authentication);
    if (result.kind === "state_conflict") return applyAgentRunSessionRenewal(apiErrorResponse(409, "HUMAN_REVIEW_STATE_CONFLICT", "人工确认已被处理或当前状态不允许提交。"), authentication);
    if (result.kind === "idempotency_conflict") return applyAgentRunSessionRenewal(apiErrorResponse(409, "IDEMPOTENCY_CONFLICT", "幂等键与已有人工确认提交不一致。"), authentication);
    if (result.kind === "expired") return applyAgentRunSessionRenewal(apiErrorResponse(409, "HUMAN_REVIEW_EXPIRED", "人工确认已过期，请重新生成学习路线。"), authentication);
    if (result.kind === "answer_invalid") return applyAgentRunSessionRenewal(apiErrorResponse(422, "HUMAN_REVIEW_ANSWER_INVALID", "答案必须覆盖当前问题，并且只能选择当前批次中的选项。"), authentication);
    return applyAgentRunSessionRenewal(NextResponse.json({ id: result.runId, status: "queued", review_id: result.reviewId }), authentication);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return applyAgentRunSessionRenewal(apiErrorResponse(422, "HUMAN_REVIEW_CONTRACT_INVALID", "人工确认问题合同不合法。"), authentication);
    }
    return applyAgentRunSessionRenewal(apiErrorResponse(500, "INTERNAL_ERROR", "人工确认暂时无法提交，请稍后重试。"), authentication);
  }
}
