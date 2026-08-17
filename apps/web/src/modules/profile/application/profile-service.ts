/**
 * Profile 限界上下文的应用服务。
 *
 * 导出：
 * - ProfileService：保存学习者画像、创建目标及读取用户拥有资源的用例编排。
 */

import { createHash } from "node:crypto";

import {
  type CreateLearningGoalInput,
  type CreateLearningGoalResult,
  type LearnerProfileSnapshot,
  type LearningGoalListItemSnapshot,
  type LearningGoalSnapshot,
  ProfileApplicationError,
  type ProfileRepository,
  type SaveLearnerProfileInput,
} from "../domain/profile";

export class ProfileService {
  constructor(private readonly repository: ProfileRepository) {}

  getProfile(ownerId: string): Promise<LearnerProfileSnapshot | null> {
    return this.repository.findProfile(ownerId);
  }

  saveProfile(input: SaveLearnerProfileInput): Promise<LearnerProfileSnapshot> {
    return this.repository.saveProfile({
      ...input,
      operatingSystem: input.operatingSystem?.trim() || null,
      backgroundSummary: input.backgroundSummary?.trim() || null,
    });
  }

  async createGoal(input: CreateLearningGoalInput): Promise<CreateLearningGoalResult> {
    const profile = await this.repository.findProfile(input.ownerId);
    if (!profile) {
      throw new ProfileApplicationError("PROFILE_REQUIRED");
    }

    if (input.modelConnectionId) {
      const isOwnedConnection = await this.repository.isActiveModelConnectionOwned(
        input.ownerId,
        input.modelConnectionId,
      );
      if (!isOwnedConnection) {
        throw new ProfileApplicationError("MODEL_CONNECTION_NOT_FOUND");
      }
    }

    const normalizedInput = {
      ...input,
      topic: input.topic.trim(),
      title: input.title.trim(),
      description: input.description.trim(),
      desiredOutcome: input.desiredOutcome.trim(),
    };

    return this.repository.createGoal({
      ...normalizedInput,
      requestHash: createRequestHash(normalizedInput),
      profileVersion: profile.profileVersion,
    });
  }

  async getOwnedGoal(ownerId: string, goalId: string): Promise<LearningGoalSnapshot> {
    const goal = await this.repository.findOwnedGoal(ownerId, goalId);
    if (!goal) {
      throw new ProfileApplicationError("LEARNING_GOAL_NOT_FOUND");
    }

    return goal;
  }

  listOwnedGoals(ownerId: string): Promise<LearningGoalListItemSnapshot[]> {
    return this.repository.findOwnedGoals(ownerId);
  }

  async deleteOwnedGoal(ownerId: string, goalId: string): Promise<void> {
    const decision = await this.repository.deleteOwnedGoal(ownerId, goalId);
    if (decision === "not_found") {
      throw new ProfileApplicationError("LEARNING_GOAL_NOT_FOUND");
    }
    if (decision === "has_active_runs") {
      throw new ProfileApplicationError("GOAL_HAS_ACTIVE_RUNS");
    }
  }
}

function createRequestHash(input: CreateLearningGoalInput): string {
  const payload = {
    topic: input.topic,
    title: input.title,
    description: input.description,
    desired_outcome: input.desiredOutcome,
    target_date: input.targetDate,
    weekly_minutes_override: input.weeklyMinutesOverride,
    model_connection_id: input.modelConnectionId,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
