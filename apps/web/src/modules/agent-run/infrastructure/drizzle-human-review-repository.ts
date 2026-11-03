/**
 * Human-in-the-Loop 人工确认的 Drizzle Repository。
 * 调用顺序：创建等待记录 → 按所有者读取 → 后续答案提交服务复用同一记录并保持 AgentRun 输入快照不可变。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { agentHumanReviews } from "@/lib/db/schema";

import {
  HumanReviewQuestionBatchSchema,
  HumanReviewAnswerSchema,
  HumanReviewStatusSchema,
  type HumanReviewAnswer,
  type HumanReviewQuestionBatch,
  type HumanReviewSnapshot,
  type HumanReviewStatus,
} from "../domain/human-review";

type HumanReviewRecord = typeof agentHumanReviews.$inferSelect;

export interface CreateHumanReviewInput {
  agentRunId: string;
  ownerId: string;
  goalId: string;
  threadId: string;
  graphVersion: string;
  questions: HumanReviewQuestionBatch;
  expiresAt: Date;
}

export interface HumanReviewRepository {
  createWaiting(input: CreateHumanReviewInput): Promise<HumanReviewSnapshot>;
  findOwnedByRun(ownerId: string, agentRunId: string): Promise<HumanReviewSnapshot | null>;
}

export class DrizzleHumanReviewRepository implements HumanReviewRepository {
  async createWaiting(input: CreateHumanReviewInput): Promise<HumanReviewSnapshot> {
    const questions = HumanReviewQuestionBatchSchema.parse(input.questions);
    const database = getDatabase();
    const [record] = await database.insert(agentHumanReviews).values({
      agentRunId: input.agentRunId,
      ownerId: input.ownerId,
      goalId: input.goalId,
      threadId: input.threadId,
      schemaVersion: questions.schema_version,
      graphVersion: input.graphVersion,
      questionsJson: questions,
      answersJson: [],
      status: "waiting",
      expiresAt: input.expiresAt,
    }).returning();

    if (!record) {
      throw new Error("创建人工确认记录后未返回记录。");
    }
    return toHumanReviewSnapshot(record);
  }

  async findOwnedByRun(ownerId: string, agentRunId: string): Promise<HumanReviewSnapshot | null> {
    const database = getDatabase();
    const [record] = await database.select().from(agentHumanReviews).where(and(
      eq(agentHumanReviews.ownerId, ownerId),
      eq(agentHumanReviews.agentRunId, agentRunId),
    )).limit(1);
    return record ? toHumanReviewSnapshot(record) : null;
  }
}

function toHumanReviewSnapshot(record: HumanReviewRecord): HumanReviewSnapshot {
  const questions = HumanReviewQuestionBatchSchema.parse(record.questionsJson);
  const answersValue = Array.isArray(record.answersJson) ? record.answersJson : [];
  const answers = answersValue.map((value) => HumanReviewAnswerSchema.parse(value));
  const status = HumanReviewStatusSchema.parse(record.status);
  return {
    id: record.id,
    agentRunId: record.agentRunId,
    ownerId: record.ownerId,
    goalId: record.goalId,
    threadId: record.threadId,
    schemaVersion: record.schemaVersion,
    graphVersion: record.graphVersion,
    questions,
    answers,
    status,
    idempotencyKey: record.idempotencyKey,
    expiresAt: record.expiresAt,
    submittedAt: record.submittedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
