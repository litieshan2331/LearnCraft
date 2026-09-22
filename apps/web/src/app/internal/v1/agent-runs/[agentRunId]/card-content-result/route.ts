/**
 * Agent Worker 提交节点知识内容结果的内部 Route Handler。
 *
 * 主要职责：
 * - 校验共享内部密钥和 card_content 合同（**v2**：files 数组 + 对象化 call_sequence + 字符串 expected_output）。
 * - 校验 AgentRun 的目标节点与所有权。
 * - 在事务中幂等写入唯一成功的 card_contents，并更新节点内容状态。
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq, max } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { agentRuns, cardContents, planNodes } from "@/lib/db/schema";
import {
  CARD_CONTENT_FILE_ROLES,
  CARD_CONTENT_LANGUAGES,
  CARD_CONTENT_LIMITS,
} from "@/modules/content/domain/content-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

const fileSchema = z.object({
  /** 仓库相对路径，例如 src/types/todo.ts。 */
  path: z.string().min(1).max(200),
  language: z.enum(CARD_CONTENT_LANGUAGES),
  role: z.enum(CARD_CONTENT_FILE_ROLES).default("module"),
  content: z.string().min(1).max(CARD_CONTENT_LIMITS.maxFileChars),
}).strict();

const callStepSchema = z.object({
  /** 从 1 连续编号。 */
  step: z.number().int().min(1).max(CARD_CONTENT_LIMITS.maxCallSteps),
  file: z.string().min(1).max(200),
  function: z.string().min(1).max(120),
  note: z.string().min(1).max(300),
}).strict();

const workedExampleSchema = z.object({
  explanation: z.string().min(1).max(4_000),
  files: z.array(fileSchema).min(1).max(CARD_CONTENT_LIMITS.maxFiles),
  entry_file: z.string().min(1).max(200),
  call_sequence: z.array(callStepSchema).min(1).max(CARD_CONTENT_LIMITS.maxCallSteps),
  // 与 Worker 合同一致：expected_output 保持字符串，格式由提示词约束（"文件 › 函数：" 前缀）。
  expected_output: z.string().min(1).max(4_000),
}).strict().superRefine((value, context) => {
  const paths = new Set<string>();
  value.files.forEach((file, index) => {
    if (paths.has(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "文件路径不能重复。" });
    }
    paths.add(file.path);
  });

  const totalChars = value.files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalChars > CARD_CONTENT_LIMITS.maxTotalChars) {
    context.addIssue({
      code: "custom",
      path: ["files"],
      message: "示例代码总长度不能超过 " + String(CARD_CONTENT_LIMITS.maxTotalChars) + " 字符。",
    });
  }

  if (!paths.has(value.entry_file)) {
    context.addIssue({ code: "custom", path: ["entry_file"], message: "entry_file 必须是 files 中已存在的路径。" });
  }

  value.call_sequence.forEach((call, index) => {
    if (call.step !== index + 1) {
      context.addIssue({ code: "custom", path: ["call_sequence", index, "step"], message: "step 必须从 1 连续编号。" });
    }
    if (!paths.has(call.file)) {
      context.addIssue({ code: "custom", path: ["call_sequence", index, "file"], message: "file 必须是 files 中已存在的路径。" });
    }
  });
});

const teachingMemorySchema = z.object({
  key_concepts: z.array(z.string().min(1).max(300)).min(1).max(30),
  common_mistakes: z.array(z.string().min(1).max(500)).max(30),
  assessment_targets: z.array(z.string().min(1).max(500)).min(1).max(30),
}).strict();

const pitfallDebugSchema = z.object({
  title: z.string().min(1).max(300),
  cause: z.string().min(1).max(2_000),
  fix: z.string().min(1).max(2_000),
}).strict();
const resultSchema = z.object({
  plan_node_id: z.uuid(),
  schema_version: z.literal("card_content.v2"),
  foundation: z.string().min(1).max(12_000),
  worked_example: workedExampleSchema,
  pitfalls_debug: z.array(pitfallDebugSchema).min(1),
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
