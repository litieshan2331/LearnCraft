/**
 * Profile 应用服务的单元测试。
 *
 * 测试：
 * - ProfileService.createGoal：要求画像已完成，校验目标级模型连接归属，并冻结画像版本和请求哈希。
 * - ProfileService.listOwnedGoals：返回当前用户自己的目标列表及最新前测摘要。
 * - ProfileService.deleteOwnedGoal：映射不存在目标和活动任务的删除决策。
 */

import { describe, expect, it } from "vitest";

import {
  type CreateLearningGoalInput,
  type CreateLearningGoalResult,
  type LearnerProfileSnapshot,
  type LearningGoalDeletionDecision,
  type LearningGoalListItemSnapshot,
  type LearningGoalSnapshot,
  type ProfileRepository,
  type SaveLearnerProfileInput,
} from "../domain/profile";
import { ProfileService } from "./profile-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const goalId = "04d90a58-a556-45d2-9e63-108e2a261d58";

const learnerProfile: LearnerProfileSnapshot = {
  userId: ownerId,
  currentLevel: "beginner",
  primaryLanguage: "zh-CN",
  weeklyMinutes: 300,
  operatingSystem: "windows",
  backgroundSummary: null,
  contentPreference: "balanced",
  profileVersion: 3,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

const learningGoal: LearningGoalSnapshot = {
  id: goalId,
  ownerId,
  topic: "Vue 3 + TypeScript",
  title: "Vue 3 基础",
  description: "学习 Composition API 和 TypeScript",
  desiredOutcome: "完成一个数据看板",
  targetDate: null,
  weeklyMinutesOverride: null,
  modelConnectionId: null,
  profileVersion: learnerProfile.profileVersion,
  status: "assessment_pending",
  activeLearningPlanId: null,
  latestPlanRunId: null,
  latestAssessmentRunId: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

class FakeProfileRepository implements ProfileRepository {
  profile: LearnerProfileSnapshot | null = learnerProfile;
  ownsActiveModelConnection = true;
  createdGoalInput: (CreateLearningGoalInput & { profileVersion: number }) | null = null;
  deletionDecision: LearningGoalDeletionDecision = "deleted";
  goals: LearningGoalListItemSnapshot[] = [
    {
      ...learningGoal,
      latestDiagnosticAssessment: {
        id: "6d1c543c-9681-45c1-a4e2-926fc7d6a13b",
        status: "graded",
        questionCount: 12,
        difficulty: "normal",
        scorePercent: 83.33,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:05:00.000Z"),
      },
    },
  ];

  async findProfile(): Promise<LearnerProfileSnapshot | null> {
    return this.profile;
  }

  async saveProfile(input: SaveLearnerProfileInput): Promise<LearnerProfileSnapshot> {
    return {
      ...learnerProfile,
      currentLevel: input.currentLevel,
      weeklyMinutes: input.weeklyMinutes,
      operatingSystem: input.operatingSystem,
      backgroundSummary: input.backgroundSummary,
      contentPreference: input.contentPreference,
    };
  }

  async isActiveModelConnectionOwned(): Promise<boolean> {
    return this.ownsActiveModelConnection;
  }

  async createGoal(
    input: CreateLearningGoalInput & { profileVersion: number },
  ): Promise<CreateLearningGoalResult> {
    this.createdGoalInput = input;
    return {
      goal: {
        ...learningGoal,
        topic: input.topic,
        title: input.title,
        description: input.description,
        desiredOutcome: input.desiredOutcome,
        profileVersion: input.profileVersion,
        modelConnectionId: input.modelConnectionId,
      },
      created: true,
    };
  }

  async findOwnedGoal(): Promise<LearningGoalSnapshot | null> {
    return learningGoal;
  }

  async findOwnedGoals(): Promise<LearningGoalListItemSnapshot[]> {
    return this.goals;
  }

  async deleteOwnedGoal(): Promise<LearningGoalDeletionDecision> {
    return this.deletionDecision;
  }
}

describe("ProfileService.createGoal", () => {
  it("要求用户先完成学习画像", async () => {
    const repository = new FakeProfileRepository();
    repository.profile = null;
    const service = new ProfileService(repository);

    await expect(service.createGoal(createGoalInput())).rejects.toMatchObject({
      code: "PROFILE_REQUIRED",
    });
  });

  it("拒绝不属于当前账户或不可用的目标级模型连接", async () => {
    const repository = new FakeProfileRepository();
    repository.ownsActiveModelConnection = false;
    const service = new ProfileService(repository);

    await expect(service.createGoal(createGoalInput({ modelConnectionId: goalId }))).rejects.toMatchObject({
      code: "MODEL_CONNECTION_NOT_FOUND",
    });
  });

  it("创建目标时冻结当前画像版本并生成规范请求哈希", async () => {
    const repository = new FakeProfileRepository();
    const service = new ProfileService(repository);

    await service.createGoal(createGoalInput());

    expect(repository.createdGoalInput?.profileVersion).toBe(3);
    expect(repository.createdGoalInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.createdGoalInput?.topic).toBe("Vue 3 + TypeScript");
    expect(repository.createdGoalInput?.title).toBe("Vue 3 基础");
  });
});

describe("ProfileService.listOwnedGoals", () => {
  it("返回当前用户的目标列表，不要求画像仍然存在", async () => {
    const repository = new FakeProfileRepository();
    repository.profile = null;
    const service = new ProfileService(repository);

    await expect(service.listOwnedGoals(ownerId)).resolves.toEqual(repository.goals);
  });
});

describe("ProfileService.deleteOwnedGoal", () => {
  it("将活动 AgentRun 映射为拒绝删除的稳定错误", async () => {
    const repository = new FakeProfileRepository();
    repository.deletionDecision = "has_active_runs";
    const service = new ProfileService(repository);

    await expect(service.deleteOwnedGoal(ownerId, goalId)).rejects.toMatchObject({
      code: "GOAL_HAS_ACTIVE_RUNS",
    });
  });

  it("将不可见或不存在的目标映射为统一的未找到错误", async () => {
    const repository = new FakeProfileRepository();
    repository.deletionDecision = "not_found";
    const service = new ProfileService(repository);

    await expect(service.deleteOwnedGoal(ownerId, goalId)).rejects.toMatchObject({
      code: "LEARNING_GOAL_NOT_FOUND",
    });
  });
});

function createGoalInput(
  overrides: Partial<CreateLearningGoalInput> = {},
): CreateLearningGoalInput {
  return {
    ownerId,
    topic: "  Vue 3 + TypeScript  ",
    title: "  Vue 3 基础  ",
    description: "  学习 Composition API 和 TypeScript  ",
    desiredOutcome: "  完成一个数据看板  ",
    targetDate: null,
    weeklyMinutesOverride: null,
    modelConnectionId: null,
    idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    requestHash: "",
    ...overrides,
  };
}
