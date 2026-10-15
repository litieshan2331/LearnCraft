/**
 * 学习助手 Worker 写入助手与工具消息的内部接口。
 * 调用顺序：校验共享密钥 → 校验消息合同 → 由 run_id 反查所有者 → 调用学习助手 Repository 幂等写入。
 * 消息内容可以进入公开历史；模型原始轨迹仍只写内部轨迹表，不通过本接口暴露。
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

const toolCallSchema = z.object({
  id: z.string().min(1).max(150), name: z.string().min(1).max(100), arguments_json: z.string().max(20_000),
}).strict();
const messageSchema = z.object({
  id: z.uuid(), role: z.enum(["assistant", "tool"]), content: z.string().nullable(),
  tool_call_id: z.string().max(150).nullable().optional(), name: z.string().max(100).nullable().optional(),
  turn_no: z.number().int().positive(), tool_calls: z.array(toolCallSchema).max(20).optional(),
}).strict();
const requestSchema = z.object({ messages: z.array(messageSchema).min(1).max(100) }).strict();

/** 幂等追加本轮产生的助手和工具消息。 */
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
    const saved = await getLearningAssistantRepository().appendRunMessages(run.ownerId, runId.data, parsed.data.messages.map((message) => ({
      id: message.id, role: message.role, content: message.content, toolCallId: message.tool_call_id ?? null,
      toolName: message.name ?? null,
      metadataJson: { tool_calls: message.tool_calls ?? [], turn_no: message.turn_no },
    })));
    return NextResponse.json({ run_id: runId.data, status: "running", message_ids: saved.map((message) => message.id) });
  } catch (error) {
    if (error instanceof LearningAssistantRepositoryError) {
      return NextResponse.json({ error: "LEARNING_ASSISTANT_MESSAGE_WRITE_REJECTED" }, { status: 409 });
    }
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
