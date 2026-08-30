/**
 * Agent Worker 读取节点后测固定内容上下文的内部 Route Handler。
 *
 * 主要职责：校验内部密钥和 AgentRun 类型，读取 ready CardContent 与 teaching_memory。
 */

import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { agentRuns, cardContents } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { agentRunId } = await context.params;
  const runId = z.uuid().safeParse(agentRunId);
  if (!runId.success) {
    return NextResponse.json({ error: "INVALID_AGENT_RUN_ID" }, { status: 400 });
  }

  const database = getDatabase();
  const [run] = await database
    .select({
      ownerId: agentRuns.ownerId,
      targetId: agentRuns.targetId,
      targetType: agentRuns.targetType,
      runType: agentRuns.runType,
      inputSummaryJson: agentRuns.inputSummaryJson,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId.data))
    .limit(1);

  if (!run || run.runType !== "posttest_generate" || run.targetType !== "plan_node") {
    return NextResponse.json({ error: "CARD_CONTENT_CONTEXT_NOT_FOUND" }, { status: 404 });
  }

  const inputSummary = toRecord(run.inputSummaryJson);
  const sourceId = typeof inputSummary.source_card_content_id === "string"
    ? inputSummary.source_card_content_id
    : null;
  const parsedSourceId = sourceId ? z.uuid().safeParse(sourceId) : null;
  if (!parsedSourceId?.success) {
    return NextResponse.json({ error: "CARD_CONTENT_CONTEXT_INVALID" }, { status: 422 });
  }

  const [content] = await database
    .select()
    .from(cardContents)
    .where(and(
      eq(cardContents.id, parsedSourceId.data),
      eq(cardContents.ownerId, run.ownerId),
      eq(cardContents.planNodeId, run.targetId),
      eq(cardContents.status, "ready"),
    ))
    .limit(1);

  if (!content) {
    return NextResponse.json({ error: "CARD_CONTENT_CONTEXT_NOT_FOUND" }, { status: 404 });
  }

  const publicContent = toRecord(content.publicContentJson);
  const teachingMemory = toRecord(content.runnerSpecJson).teaching_memory;
  if (!isRecord(teachingMemory)) {
    return NextResponse.json({ error: "CARD_CONTENT_CONTEXT_INVALID" }, { status: 422 });
  }

  return NextResponse.json({
    plan_node_id: content.planNodeId,
    card_content_id: content.id,
    foundation: publicContent.foundation,
    worked_example: publicContent.worked_example,
    pitfalls_debug: publicContent.pitfalls_debug,
    teaching_memory: teachingMemory,
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
