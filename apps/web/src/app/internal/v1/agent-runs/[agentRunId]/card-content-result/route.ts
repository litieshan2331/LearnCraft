/**
 * Agent Worker 提交节点知识内容结果的内部 Route Handler。
 *
 * 主要职责：
 * - 校验共享内部密钥和 card_content 合同。
 * - 校验 AgentRun 的目标节点与所有权。
 * - 在事务中幂等写入唯一成功的 card_contents，并更新节点内容状态。
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq, max } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { agentRuns, cardContents, planNodes } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

const workedExampleSchema = z.object({
  explanation: z.string().min(1).max(4_000),
  code: z.string().min(1).max(12_000),
  call_sequence: z.array(z.string().min(1).max(500)).min(1).max(50),
  expected_output: z.string().min(1).max(4_000),
}).strict();

const teachingMemorySchema = z.object({
  key_concepts: z.array(z.string().min(1).max(300)).min(1).max(30),
  common_mistakes: z.array(z.string().min(1).max(500)).max(30),
  assessment_targets: z.array(z.string().min(1).max(500)).min(1).max(30),
}).strict();

const resultSchema = z.object({
  plan_node_id: z.uuid(),
  schema_version: z.literal("card_content.v1"),
  foundation: z.string().min(1).max(12_000),
  worked_example: workedExampleSchema,
  pitfalls_debug: z.string().min(1).max(12_000),
  source_refs: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  teaching_memory: teachingMemorySchema,
  generation_metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

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
        targetId: agentRuns.targetId,
        targetType: agentRuns.targetType,
        runType: agentRuns.runType,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId.data))
      .limit(1);

    if (!run || run.runType !== "card_content_generate" || run.targetType !== "plan_node") {
      return { kind: "not_found" as const };
    }
    if (run.targetId !== parsed.data.plan_node_id) {
      return { kind: "contract_mismatch" as const };
    }

    const [node] = await transaction
      .select({ id: planNodes.id, ownerId: planNodes.ownerId })
      .from(planNodes)
      .where(and(
        eq(planNodes.id, run.targetId),
        eq(planNodes.ownerId, run.ownerId),
      ))
      .limit(1)
      .for("update");

    if (!node) {
      return { kind: "not_found" as const };
    }

    const [existingReady] = await transaction
      .select({ id: cardContents.id, status: cardContents.status })
      .from(cardContents)
      .where(and(
        eq(cardContents.planNodeId, node.id),
        eq(cardContents.ownerId, run.ownerId),
        eq(cardContents.status, "ready"),
      ))
      .limit(1);

    if (existingReady) {
      return { kind: "ok" as const, id: existingReady.id, status: existingReady.status };
    }

    const [latestVersion] = await transaction
      .select({ version: max(cardContents.version) })
      .from(cardContents)
      .where(and(
        eq(cardContents.planNodeId, node.id),
        eq(cardContents.ownerId, run.ownerId),
      ));
    const version = Number(latestVersion?.version ?? 0) + 1;
    const contentHash = createHash("sha256")
      .update(JSON.stringify({
        foundation: parsed.data.foundation,
        worked_example: parsed.data.worked_example,
        pitfalls_debug: parsed.data.pitfalls_debug,
        source_refs: parsed.data.source_refs,
        teaching_memory: parsed.data.teaching_memory,
      }))
      .digest("hex");
    const now = new Date();

    const [content] = await transaction
      .insert(cardContents)
      .values({
        ownerId: run.ownerId,
        planNodeId: node.id,
        version,
        status: "ready",
        schemaVersion: parsed.data.schema_version,
        publicContentJson: {
          foundation: parsed.data.foundation,
          worked_example: parsed.data.worked_example,
          pitfalls_debug: parsed.data.pitfalls_debug,
          source_refs: parsed.data.source_refs,
        },
        runnerSpecJson: {
          teaching_memory: parsed.data.teaching_memory,
        },
        generationMetadata: {
          ...parsed.data.generation_metadata,
          agent_run_id: runId.data,
          content_hash: contentHash,
        },
        contentHash,
        generatedAt: now,
      })
      .returning({ id: cardContents.id });

    if (!content) {
      throw new Error("card_content 插入后未返回记录。");
    }

    await transaction
      .update(planNodes)
      .set({
        contentStatus: "ready",
        updatedAt: now,
      })
      .where(and(
        eq(planNodes.id, node.id),
        eq(planNodes.ownerId, run.ownerId),
      ));

    return { kind: "ok" as const, id: content.id, status: "ready" };
  });

  if (persisted.kind === "not_found") {
    return NextResponse.json({ error: "AGENT_RUN_NOT_FOUND" }, { status: 404 });
  }
  if (persisted.kind === "contract_mismatch") {
    return NextResponse.json({ error: "AGENT_RUN_RESULT_CONTRACT_MISMATCH" }, { status: 422 });
  }

  return NextResponse.json({
    card_content_id: persisted.id,
    status: persisted.status,
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
