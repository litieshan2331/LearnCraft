/**
 * 学习助手 Worker 请求验证或写入学习经历的内部接口。
 * 调用顺序：校验共享密钥 → 校验候选结构 → 由 run_id 反查会话和用户 → 检查证据来源与后续表现 → 幂等写入长期经历。
 * 模型置信度只作为候选错因的自评字段；服务端不会仅凭该字段认定修复成功。
 */
import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { assessmentAnswers, assessmentAttempts, assessments, learningAssistantConversations, learningAssistantMessages, learningAssistantRuns } from "@/lib/db/schema";
import { LearningAssistantRepositoryError } from "@/modules/learning-assistant/domain/learning-assistant";
import { getLearningAssistantRepository } from "@/modules/learning-assistant/infrastructure/learning-assistant-repository-factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

const evidenceSchema = z.object({
  id: z.string().min(1), kind: z.enum(["user_message", "assessment_answer", "tool_result", "external_source"]),
  source_id: z.string().min(1), content: z.string().min(1).max(20_000), turn_no: z.number().int().positive().nullable(), executed: z.boolean(),
}).strict();
const verificationSchema = z.object({
  status: z.enum(["not_verified", "model_evaluated", "verified"]), conclusion: z.string().max(3_000),
  evidence_ids: z.array(z.string().min(1)), demonstrated_progress: z.boolean(),
}).strict();
const hypothesisSchema = z.object({
  error_type: z.enum(["concept_gap", "reasoning_step", "api_usage", "boundary_case", "careless_check"]),
  explanation: z.string().min(1).max(3_000), evidence_ids: z.array(z.string().min(1)).min(1), confidence: z.number().min(0).max(1),
}).strict();
const candidateSchema = z.object({
  verification: verificationSchema,
  evidence: z.array(evidenceSchema).min(1),
  diagnosis: z.object({
    status: z.enum(["hypothesis", "insufficient_evidence"]), hypotheses: z.array(hypothesisSchema).max(5),
    verification_direction: z.string().min(1).max(3_000), verification: verificationSchema,
  }).strict().nullable(),
  evaluation: z.enum(["executed", "model_evaluated"]),
}).strict();
const requestSchema = z.object({ operation: z.enum(["validate", "write"]), candidate: candidateSchema }).strict();

/** 验证候选学习经历，并在 operation=write 时幂等写入。 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const params = await context.params;
  const runId = z.uuid().safeParse(params.runId);
  if (!runId.success) return NextResponse.json({ error: "INVALID_RUN_ID" }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 }); }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", field_errors: parsed.error.issues }, { status: 422 });

  const database = getDatabase();
  const [run] = await database.select({ ownerId: learningAssistantRuns.ownerId, conversationId: learningAssistantRuns.conversationId, status: learningAssistantRuns.status, sourceAssessmentAnswerId: learningAssistantConversations.sourceAssessmentAnswerId })
    .from(learningAssistantRuns).innerJoin(learningAssistantConversations, eq(learningAssistantConversations.id, learningAssistantRuns.conversationId))
    .where(eq(learningAssistantRuns.id, runId.data)).limit(1);
  if (!run) return NextResponse.json({ error: "LEARNING_ASSISTANT_RUN_NOT_FOUND" }, { status: 404 });
  const canonicalEvidence = await validateCandidate(database, run, parsed.data.candidate);
  if (canonicalEvidence === null) return NextResponse.json({ accepted: false, memory_id: null, created: false });
  if (parsed.data.operation === "validate") return NextResponse.json({ accepted: true, memory_id: null, created: false });

  const candidate = parsed.data.candidate;
  const hypothesis = candidate.diagnosis?.hypotheses[0];
  const assessmentEvidence = candidate.evidence.find((item) => item.kind === "assessment_answer");
  try {
    const saved = await getLearningAssistantRepository().recordLearningMemory({
      id: runId.data, ownerId: run.ownerId, conversationId: run.conversationId, sourceRunId: runId.data,
      sourceAssessmentAnswerId: assessmentEvidence?.source_id ?? null,
      memoryType: hypothesis === undefined ? "intervention_result" : "error_pattern",
      knowledgePoint: null, errorType: hypothesis?.error_type ?? null,
      pattern: hypothesis?.explanation ?? candidate.verification.conclusion,
      evidenceJson: canonicalEvidence,
      interventionJson: { evaluation: candidate.evaluation, verification: candidate.verification },
      repairStatus: candidate.verification.status === "verified" ? "repaired" : "improving",
      confidence: hypothesis?.confidence ?? (candidate.verification.status === "verified" ? 1 : 0.5),
      observedAt: new Date(),
    });
    return NextResponse.json({ accepted: true, memory_id: saved.memory.id, created: saved.created });
  } catch (error) {
    if (error instanceof LearningAssistantRepositoryError) return NextResponse.json({ error: "LEARNING_ASSISTANT_MEMORY_REJECTED" }, { status: 409 });
    throw error;
  }
}

/** 检查运行状态、证据真实性和用户实际推进，拒绝只说“明白了”的记忆候选。 */
async function validateCandidate(
  database: ReturnType<typeof getDatabase>,
  run: { ownerId: string; conversationId: string; status: string; sourceAssessmentAnswerId: string | null },
  candidate: z.infer<typeof candidateSchema>,
): Promise<Array<{ kind: "user_message" | "assessment_answer"; sourceId: string; observation: string }> | null> {
  if (!(run.status === "running" || run.status === "succeeded")) return null;
  if (candidate.verification.status === "not_verified" || !candidate.verification.demonstrated_progress) return null;
  if (candidate.diagnosis?.status === "insufficient_evidence") return null;
  const evidenceById = new Map(candidate.evidence.map((item) => [item.id, item]));
  const referenced = [...candidate.verification.evidence_ids, ...(candidate.diagnosis?.hypotheses.flatMap((item) => item.evidence_ids) ?? [])];
  if (referenced.some((id) => !evidenceById.has(id))) return null;
  const durableEvidence = candidate.evidence.filter((item) => item.kind === "user_message" || item.kind === "assessment_answer");
  if (durableEvidence.length === 0 || candidate.evidence.some((item) => item.kind === "external_source" || item.kind === "tool_result")) return null;
  if (durableEvidence.some((item) => item.kind === "assessment_answer" && item.source_id !== run.sourceAssessmentAnswerId)) return null;

  const canonicalEvidence: Array<{ kind: "user_message" | "assessment_answer"; sourceId: string; observation: string }> = [];
  for (const item of durableEvidence) {
    if (item.kind === "user_message") {
      const [message] = await database.select({ id: learningAssistantMessages.id, content: learningAssistantMessages.content }).from(learningAssistantMessages).where(and(
        eq(learningAssistantMessages.id, item.source_id), eq(learningAssistantMessages.conversationId, run.conversationId), eq(learningAssistantMessages.role, "user"),
      )).limit(1);
      if (!message || message.content === null || /^(明白了|懂了|知道了|ok|好的)[。！!\s]*$/i.test(message.content.trim())) return null;
      canonicalEvidence.push({ kind: "user_message", sourceId: message.id, observation: message.content });
    } else {
      const [answer] = await database.select({ id: assessmentAnswers.id, answerJson: assessmentAnswers.answerJson, isCorrect: assessmentAnswers.isCorrect, feedback: assessmentAnswers.feedback }).from(assessmentAnswers)
        .innerJoin(assessmentAttempts, eq(assessmentAttempts.id, assessmentAnswers.attemptId))
        .innerJoin(assessments, eq(assessments.id, assessmentAttempts.assessmentId))
        .where(and(eq(assessmentAnswers.id, item.source_id), eq(assessmentAttempts.ownerId, run.ownerId), eq(assessments.ownerId, run.ownerId))).limit(1);
      if (!answer) return null;
      canonicalEvidence.push({ kind: "assessment_answer", sourceId: answer.id, observation: JSON.stringify({ answer_json: answer.answerJson, is_correct: answer.isCorrect, feedback: answer.feedback }) });
    }
  }
  return canonicalEvidence;
}

/** 使用恒定时间比较内部服务密钥。 */
function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected, "utf8"); const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
