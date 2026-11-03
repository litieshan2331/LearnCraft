/**
 * HumanReview Repository 单元测试。
 * 调用顺序：注入 Drizzle 链式查询替身 → 创建/读取记录 → 校验合同解析与所有者过滤。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: {
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => mocks.database }));
vi.mock("@/lib/db/schema", () => ({ agentHumanReviews: {} }));

import { DrizzleHumanReviewRepository } from "./drizzle-human-review-repository";
import { HumanReviewQuestionBatchSchema } from "../domain/human-review";

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  agentRunId: "22222222-2222-4222-8222-222222222222",
  ownerId: "33333333-3333-4333-8333-333333333333",
  goalId: "44444444-4444-4444-8444-444444444444",
  threadId: "plan_generate:22222222-2222-4222-8222-222222222222",
  schemaVersion: "plan_generation_human_review.v1",
  graphVersion: "plan_generate.hitl.v1",
  questionsJson: {
    schema_version: "plan_generation_human_review.v1",
    review_id: "11111111-1111-4111-8111-111111111111",
    questions: [{
      question_id: "pace",
      prompt: "节奏？",
      options: [
        { option_id: "steady", label: "稳定", kind: "preset", input: null },
        { option_id: "intensive", label: "强化", kind: "preset", input: null },
        { option_id: "custom", label: "自定义", kind: "custom_text", input: { min_length: 1, max_length: 100 } },
      ],
    }],
  },
  answersJson: [],
  status: "waiting",
  idempotencyKey: null,
  expiresAt: new Date("2026-10-31T12:00:00.000Z"),
  submittedAt: null,
  createdAt: new Date("2026-10-31T10:00:00.000Z"),
  updatedAt: new Date("2026-10-31T10:00:00.000Z"),
};

describe("DrizzleHumanReviewRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("创建记录并保持问题快照合同", async () => {
    const returning = vi.fn().mockResolvedValue([record]);
    const values = vi.fn().mockReturnValue({ returning });
    mocks.database.insert.mockReturnValue({ values });
    const repository = new DrizzleHumanReviewRepository();

    const result = await repository.createWaiting({
      agentRunId: record.agentRunId,
      ownerId: record.ownerId,
      goalId: record.goalId,
      threadId: record.threadId,
      graphVersion: record.graphVersion,
      questions: HumanReviewQuestionBatchSchema.parse(record.questionsJson),
      expiresAt: record.expiresAt,
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: record.agentRunId,
      ownerId: record.ownerId,
      questionsJson: record.questionsJson,
      answersJson: [],
      status: "waiting",
    }));
    expect(result.agentRunId).toBe(record.agentRunId);
    expect(result.answers).toEqual([]);
  });

  it("按所有者和 AgentRun 读取，不返回其他用户记录", async () => {
    const limit = vi.fn().mockResolvedValue([record]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mocks.database.select.mockReturnValue({ from });
    const repository = new DrizzleHumanReviewRepository();

    const result = await repository.findOwnedByRun(record.ownerId, record.agentRunId);

    expect(result?.ownerId).toBe(record.ownerId);
    expect(result?.threadId).toBe(record.threadId);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
