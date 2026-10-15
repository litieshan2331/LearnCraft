/**
 * 学习助手 Worker 读取运行所属用户默认模型连接的内部接口。
 * 调用顺序：校验内部服务密钥 → 校验运行 ID → 按运行所属用户读取 active 默认连接 → 返回加密凭据信封。
 * API Key 明文只在 Worker 进程内解密，模型连接身份由数据库运行记录决定。
 */
import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { learningAssistantRuns, userModelConnections } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

/** 读取学习助手运行的服务端默认模型连接。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const params = await context.params;
  const parsed = z.uuid().safeParse(params.runId);
  if (!parsed.success) return NextResponse.json({ error: "INVALID_RUN_ID" }, { status: 400 });
  const database = getDatabase();
  const [run] = await database.select({ ownerId: learningAssistantRuns.ownerId, inputSummaryJson: learningAssistantRuns.inputSummaryJson })
    .from(learningAssistantRuns).where(eq(learningAssistantRuns.id, parsed.data)).limit(1);
  if (!run) return NextResponse.json({ error: "DEFAULT_MODEL_CONNECTION_NOT_FOUND" }, { status: 404 });
  const boundConnectionId = typeof run.inputSummaryJson === "object" && run.inputSummaryJson !== null
    && typeof (run.inputSummaryJson as Record<string, unknown>).connection_id === "string"
    ? (run.inputSummaryJson as Record<string, unknown>).connection_id as string : null;
  const [record] = await database.select({
    ownerId: userModelConnections.ownerId,
    connectionId: userModelConnections.id,
    baseUrl: userModelConnections.baseUrl,
    modelId: userModelConnections.defaultModelId,
    encryptedApiKey: userModelConnections.encryptedApiKey,
    apiKeyIv: userModelConnections.apiKeyIv,
    apiKeyAuthTag: userModelConnections.apiKeyAuthTag,
    encryptionKeyVersion: userModelConnections.encryptionKeyVersion,
  }).from(userModelConnections).where(and(
    eq(userModelConnections.ownerId, run.ownerId),
    eq(userModelConnections.status, "active"),
    boundConnectionId === null ? eq(userModelConnections.isDefault, true) : eq(userModelConnections.id, boundConnectionId),
  )).limit(1);
  if (!record) return NextResponse.json({ error: "DEFAULT_MODEL_CONNECTION_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ owner_id: record.ownerId, connection_id: record.connectionId, base_url: record.baseUrl,
    model_id: record.modelId, credential: { ciphertext_base64: record.encryptedApiKey, iv_base64: record.apiKeyIv,
      auth_tag_base64: record.apiKeyAuthTag, encryption_key_version: record.encryptionKeyVersion } });
}

/** 使用恒定时间比较内部服务密钥。 */
function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected, "utf8"); const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
