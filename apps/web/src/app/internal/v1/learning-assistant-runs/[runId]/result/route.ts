/**
 * 学习助手 Worker 回写运行结果的内部接口。
 * 调用顺序：校验共享密钥 → 校验状态、统计和会话阶段 → 由 run_id 反查所有者 → Repository 事务幂等提交终态。
 * 详细模型/工具轨迹不接受也不返回；轨迹由 Worker 的独立运行存储负责。
 */
import { timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { learningAssistantRuns } from "@/lib/db/schema";
import { LearningAssistantRepositoryError } from "@/modules/learning-assistant/domain/learning-assistant";
import { getLearningAssistantRepository } from "@/modules/learning-assistant/infrastructure/learning-assistant-repository-factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }
const resultMessageSchema = z.object({
  id: z.uuid(), role: z.enum(["assistant", "tool"]), content: z.string().nullable(),
  tool_name: z.string().max(100).nullable().optional(), tool_call_id: z.string().max(150).nullable().optional(),
  tool_input_json: z.record(z.string(), z.unknown()).optional(), tool_result_json: z.record(z.string(), z.unknown()).optional(),
  metadata_json: z.record(z.string(), z.unknown()).optional(),
}).strict();
const conversationSchema = z.object({
  stage: z.enum(["new", "context_loaded", "diagnosing", "waiting_for_user", "hinting", "checking_repair", "mastered", "needs_more_practice", "unresolved"]),
  state_json: z.record(z.string(), z.unknown()),
}).strict();
const requestSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  model_id: z.string().min(1).max(255).nullable().optional(),
  input_tokens: z.number().int().min(0).optional(), output_tokens: z.number().int().min(0).optional(),
  model_call_count: z.number().int().min(0).optional(), tool_call_count: z.number().int().min(0).optional(),
  sub_agent_summary_json: z.array(z.unknown()).optional(), skill_summary_json: z.array(z.unknown()).optional(),
  tavily_summary_json: z.array(z.unknown()).optional(), output_summary_json: z.record(z.string(), z.unknown()).optional(),
  error_code: z.string().min(1).max(100).nullable().optional(), error_summary: z.string().max(1000).nullable().optional(),
  messages: z.array(resultMessageSchema).max(100).optional(), conversation: conversationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "failed" && !value.error_code) {
    context.addIssue({ code: "custom", path: ["error_code"], message: "失败运行必须提供 error_code。" });
  }
});

/** 原子回写学习助手结果和终态；重复提交相同结果返回成功。 */
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
  const [run] = await database.select({ ownerId: learningAssistantRuns.ownerId }).from(learningAssistantRuns)
    .where(eq(learningAssistantRuns.id, runId.data)).limit(1);
  if (!run) return NextResponse.json({ error: "LEARNING_ASSISTANT_RUN_NOT_FOUND" }, { status: 404 });
  try {
    const saved = await getLearningAssistantRepository().finishOwnedRun({
      ownerId: run.ownerId, runId: runId.data, status: parsed.data.status,
      modelId: parsed.data.model_id, inputTokens: parsed.data.input_tokens, outputTokens: parsed.data.output_tokens,
      modelCallCount: parsed.data.model_call_count, toolCallCount: parsed.data.tool_call_count,
      subAgentSummaryJson: parsed.data.sub_agent_summary_json, skillSummaryJson: parsed.data.skill_summary_json,
      tavilySummaryJson: parsed.data.tavily_summary_json, outputSummaryJson: parsed.data.output_summary_json,
      errorCode: parsed.data.error_code, errorSummary: parsed.data.error_summary,
      messages: parsed.data.messages?.map((message) => ({
        id: message.id, role: message.role, content: message.content, toolName: message.tool_name ?? null,
        toolCallId: message.tool_call_id ?? null, toolInputJson: message.tool_input_json ?? {},
        toolResultJson: message.tool_result_json ?? {}, metadataJson: message.metadata_json ?? {},
      })),
      conversation: parsed.data.conversation ? { stage: parsed.data.conversation.stage, stateJson: parsed.data.conversation.state_json } : undefined,
    });
    return NextResponse.json({ run_id: saved.id, status: saved.status, message_ids: parsed.data.messages?.map((message) => message.id) ?? [] });
  } catch (error) {
    if (error instanceof LearningAssistantRepositoryError) return NextResponse.json({ error: "LEARNING_ASSISTANT_RESULT_REJECTED" }, { status: 409 });
    throw error;
  }
}

/** 使用恒定时间比较内部服务密钥。 */
function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected, "utf8"); const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
