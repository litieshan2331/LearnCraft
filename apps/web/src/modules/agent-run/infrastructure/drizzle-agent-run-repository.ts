/**
 * AgentRun 的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleAgentRunRepository：在同一 PostgreSQL 事务中创建 AgentRun、审计事件与 Outbox，并以行锁实现状态读取和协作式取消。
 */

import { and, eq, max } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { agentRunEvents, agentRuns, outboxEvents } from "@/lib/db/schema";

import {
  AgentRunApplicationError,
  getAgentRunCancellationDecision,
  isAgentRunStatus,
  isAgentRunType,
  type AgentRunCancellationResult,
  type AgentRunProductionInput,
  type AgentRunProductionResult,
  type AgentRunRepository,
  type AgentRunSnapshot,
} from "../domain/agent-run";

const AGENT_RUN_REQUESTED_EVENT_TYPE = "agent.run.requested";
const AGENT_RUN_REQUESTED_EVENT_VERSION = 1;

type AgentRunRecord = typeof agentRuns.$inferSelect;

export class DrizzleAgentRunRepository implements AgentRunRepository {
  async create(input: AgentRunProductionInput): Promise<AgentRunProductionResult> {
    const database = getDatabase();

    try {
      return await database.transaction(async (transaction) => {
        const [agentRun] = await transaction
          .insert(agentRuns)
          .values({
            ownerId: input.ownerId,
            runType: input.runType,
            status: "queued",
            targetType: input.targetType,
            targetId: input.targetId,
            idempotencyKey: input.idempotencyKey,
            traceId: input.traceId,
            graphVersion: input.graphVersion,
            promptVersion: input.promptVersion ?? null,
            inputSchemaVersion: input.inputSchemaVersion,
            outputSchemaVersion: input.outputSchemaVersion ?? null,
            requestedModelProfile: input.requestedModelProfile,
            modelConnectionId: input.modelConnectionId ?? null,
            requestedModelId: input.requestedModelId ?? null,
            inputSummaryJson: input.inputSummaryJson ?? {},
          })
          .returning();

        if (!agentRun) {
          throw new Error("创建 AgentRun 后未返回运行记录。");
        }

        const now = new Date();
        await transaction.insert(agentRunEvents).values({
          agentRunId: agentRun.id,
          sequenceNo: 1,
          eventType: "run.queued",
          payloadJson: {
            run_type: input.runType,
            target_type: input.targetType,
            target_id: input.targetId,
          },
          occurredAt: now,
        });
        await transaction.insert(outboxEvents).values({
          aggregateType: "agent_run",
          aggregateId: agentRun.id,
          eventType: AGENT_RUN_REQUESTED_EVENT_TYPE,
          eventVersion: AGENT_RUN_REQUESTED_EVENT_VERSION,
          payloadJson: {
            agent_run_id: agentRun.id,
            trace_id: input.traceId,
            task_version: 1,
          },
          traceId: input.traceId,
        });

        return {
          agentRun: toAgentRunSnapshot(agentRun),
          created: true,
        };
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }

      return this.findExistingIdempotentRun(input);
    }
  }

  async findOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunSnapshot | null> {
    const database = getDatabase();
    const [agentRun] = await database
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, agentRunId), eq(agentRuns.ownerId, ownerId)))
      .limit(1);

    return agentRun ? toAgentRunSnapshot(agentRun) : null;
  }

  async cancelOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunCancellationResult> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      const [existingRun] = await transaction
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, agentRunId), eq(agentRuns.ownerId, ownerId)))
        .limit(1)
        .for("update");

      if (!existingRun) {
        return { decision: "not_cancellable", agentRun: null };
      }

      const existingSnapshot = toAgentRunSnapshot(existingRun);
      const decision = getAgentRunCancellationDecision(existingSnapshot.status);
      if (decision !== "cancel") {
        return { decision, agentRun: existingSnapshot };
      }

      const now = new Date();
      const [updatedRun] = await transaction
        .update(agentRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          errorCode: null,
          errorSummary: null,
          updatedAt: now,
        })
        .where(eq(agentRuns.id, agentRunId))
        .returning();

      if (!updatedRun) {
        throw new Error("取消 AgentRun 时未返回运行记录。");
      }

      const [lastEvent] = await transaction
        .select({ sequenceNo: max(agentRunEvents.sequenceNo) })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.agentRunId, agentRunId));
      await transaction.insert(agentRunEvents).values({
        agentRunId,
        sequenceNo: (lastEvent?.sequenceNo ?? 0) + 1,
        eventType: "run.cancelled",
        payloadJson: { cancellation_mode: "cooperative", cancelled_by: "owner" },
        occurredAt: now,
      });

      return {
        decision,
        agentRun: toAgentRunSnapshot(updatedRun),
      };
    });
  }

  private async findExistingIdempotentRun(input: AgentRunProductionInput): Promise<AgentRunProductionResult> {
    const database = getDatabase();
    const [existingRun] = await database
      .select()
      .from(agentRuns)
      .where(and(
        eq(agentRuns.ownerId, input.ownerId),
        eq(agentRuns.runType, input.runType),
        eq(agentRuns.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);

    if (!existingRun) {
      throw new Error("AgentRun 幂等冲突后未找到已有运行记录。");
    }
    if (!isSameProductionRequest(existingRun, input)) {
      throw new AgentRunApplicationError("IDEMPOTENCY_CONFLICT");
    }

    return {
      agentRun: toAgentRunSnapshot(existingRun),
      created: false,
    };
  }
}

function toAgentRunSnapshot(agentRun: AgentRunRecord): AgentRunSnapshot {
  if (!isAgentRunType(agentRun.runType) || !isAgentRunStatus(agentRun.status)) {
    throw new Error("数据库中存在不受支持的 AgentRun 类型或状态。");
  }

  const assessmentResult = toAssessmentResultSnapshot(agentRun);

  return {
    id: agentRun.id,
    runType: agentRun.runType,
    status: agentRun.status,
    targetType: agentRun.targetType,
    targetId: agentRun.targetId,
    modelConnectionId: agentRun.modelConnectionId,
    requestedModelId: agentRun.requestedModelId,
    retryCount: agentRun.retryCount,
    traceId: agentRun.traceId,
    startedAt: agentRun.startedAt,
    finishedAt: agentRun.finishedAt,
    ...(assessmentResult ? { assessmentResult } : {}),
    ...(agentRun.errorCode ? {
      error: {
        code: agentRun.errorCode,
        message: getSafeErrorMessage(agentRun.errorCode),
        retryable: false,
      },
    } : {}),
    createdAt: agentRun.createdAt,
    updatedAt: agentRun.updatedAt,
  };
}

function toAssessmentResultSnapshot(agentRun: AgentRunRecord) {
  if (agentRun.runType !== 'assessment_generate' || agentRun.status !== 'succeeded') {
    return undefined;
  }

  const summary = agentRun.outputSummaryJson;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    return undefined;
  }

  const summaryRecord = summary as { assessment_id?: unknown; question_count?: unknown };
  const assessmentId = summaryRecord.assessment_id;
  const questionCount = summaryRecord.question_count;
  if (
    typeof assessmentId !== 'string'
    || !isUuid(assessmentId)
    || typeof questionCount !== 'number'
    || !Number.isInteger(questionCount)
    || questionCount < 1
  ) {
    return undefined;
  }

  return { assessmentId, questionCount };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSameProductionRequest(existingRun: AgentRunRecord, input: AgentRunProductionInput): boolean {
  return existingRun.targetType === input.targetType
    && existingRun.targetId === input.targetId
    && existingRun.graphVersion === input.graphVersion
    && existingRun.promptVersion === (input.promptVersion ?? null)
    && existingRun.inputSchemaVersion === input.inputSchemaVersion
    && existingRun.outputSchemaVersion === (input.outputSchemaVersion ?? null)
    && existingRun.requestedModelProfile === input.requestedModelProfile
    && existingRun.modelConnectionId === (input.modelConnectionId ?? null)
    && existingRun.requestedModelId === (input.requestedModelId ?? null)
    && canonicalJson(existingRun.inputSummaryJson) === canonicalJson(input.inputSummaryJson ?? {});
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`
  )).join(",")}}`;
}

function getSafeErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case "AGENT_RUN_RETRY_EXHAUSTED":
      return "任务重试次数已用尽，请稍后重新发起。";
    case "AGENT_RUN_WORKFLOW_NOT_REGISTERED":
      return "该任务类型暂未开放执行。";
    default:
      return "任务执行失败，请稍后重新发起。";
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}
