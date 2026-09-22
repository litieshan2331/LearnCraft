/**
 * Profile 限界上下文的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleProfileRepository：读写学习者画像、学习目标、幂等键与目标级模型连接归属。
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  assessments,
  agentRuns,
  idempotencyKeys,
  learnerProfiles,
  learningGoals,
  learningPlans,
  outboxEvents,
  userModelConnections,
} from "@/lib/db/schema";

import {
  isContentPreference,
  isCurrentLevel,
  isLearningGoalStatus,
  type CreateLearningGoalInput,
  type CreateLearningGoalResult,
  isDiagnosticAssessmentStatus,
  type LearnerProfileSnapshot,
  type LearningGoalDeletionDecision,
  type LatestDiagnosticAssessmentSnapshot,
  type LearningGoalListItemSnapshot,
  type LearningGoalSnapshot,
  ProfileApplicationError,
  type ProfileRepository,
  type SaveLearnerProfileInput,
} from "../domain/profile";

type LearnerProfileRecord = typeof learnerProfiles.$inferSelect;
type LearningGoalRecord = typeof learningGoals.$inferSelect;
type DiagnosticAssessmentRecord = typeof assessments.$inferSelect;

const IDEMPOTENCY_SCOPE = "learning_goal.create";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_AGENT_RUN_STATUSES = ["queued", "running"] as const;

export class DrizzleProfileRepository implements ProfileRepository {
  async findProfile(ownerId: string): Promise<LearnerProfileSnapshot | null> {
    const database = getDatabase();
    const [profile] = await database
      .select()
      .from(learnerProfiles)
      .where(eq(learnerProfiles.userId, ownerId))
      .limit(1);

    return profile ? toLearnerProfileSnapshot(profile) : null;
  }

  async saveProfile(input: SaveLearnerProfileInput): Promise<LearnerProfileSnapshot> {
    const database = getDatabase();
    const [profile] = await database
      .insert(learnerProfiles)
      .values({
        userId: input.ownerId,
        currentLevel: input.currentLevel,
        primaryLanguage: "zh-CN",
        weeklyMinutes: input.weeklyMinutes,
        operatingSystem: input.operatingSystem,
        backgroundSummary: input.backgroundSummary,
        preferencesJson: { contentPreference: input.contentPreference },
        profileVersion: 1,
      })
      .onConflictDoUpdate({
        target: learnerProfiles.userId,
        set: {
          currentLevel: input.currentLevel,
          weeklyMinutes: input.weeklyMinutes,
          operatingSystem: input.operatingSystem,
          backgroundSummary: input.backgroundSummary,
          preferencesJson: { contentPreference: input.contentPreference },
          profileVersion: sql`${learnerProfiles.profileVersion} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!profile) {
      throw new Error("保存学习者画像后未返回记录。");
    }

    return toLearnerProfileSnapshot(profile);
  }

  async isActiveModelConnectionOwned(ownerId: string, modelConnectionId: string): Promise<boolean> {
    const database = getDatabase();
    const [connection] = await database
      .select({ id: userModelConnections.id })
      .from(userModelConnections)
      .where(and(
        eq(userModelConnections.id, modelConnectionId),
        eq(userModelConnections.ownerId, ownerId),
        eq(userModelConnections.status, "active"),
      ))
      .limit(1);

    return Boolean(connection);
  }

  async createGoal(
    input: CreateLearningGoalInput & { profileVersion: number },
  ): Promise<CreateLearningGoalResult> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      const [idempotencyRecord] = await transaction
        .insert(idempotencyKeys)
        .values({
          actorKey: input.ownerId,
          scope: IDEMPOTENCY_SCOPE,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          status: "processing",
          responseJson: {},
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id });

      if (!idempotencyRecord) {
        return this.findExistingIdempotentGoal(transaction, input);
      }

      const [goal] = await transaction
        .insert(learningGoals)
        .values({
          ownerId: input.ownerId,
          topic: input.topic,
          title: input.title,
          description: input.description,
          desiredOutcome: input.desiredOutcome,
          targetDate: input.targetDate,
          weeklyMinutesOverride: input.weeklyMinutesOverride,
          modelConnectionId: input.modelConnectionId,
          profileVersion: input.profileVersion,
          status: "assessment_pending",
          metadataJson: {},
        })
        .returning();

      if (!goal) {
        throw new Error("创建学习目标后未返回记录。");
      }

      await transaction
        .update(idempotencyKeys)
        .set({
          status: "succeeded",
          responseStatus: 201,
          resourceType: "learning_goal",
          resourceId: goal.id,
          responseJson: { goal_id: goal.id },
          updatedAt: new Date(),
        })
        .where(eq(idempotencyKeys.id, idempotencyRecord.id));

      return { goal: toLearningGoalSnapshot(goal), created: true };
    });
  }

  async findOwnedGoal(ownerId: string, goalId: string): Promise<LearningGoalSnapshot | null> {
    const database = getDatabase();
    const [goal] = await database
      .select()
      .from(learningGoals)
      .where(and(eq(learningGoals.id, goalId), eq(learningGoals.ownerId, ownerId)))
      .limit(1);

    if (!goal) {
      return null;
    }

    const [activePlan] = await database
      .select({ id: learningPlans.id })
      .from(learningPlans)
      .where(and(
        eq(learningPlans.ownerId, ownerId),
        eq(learningPlans.goalId, goal.id),
        eq(learningPlans.status, "active"),
      ))
      .limit(1);

    const inFlightByGoalId = await findInFlightGenerationsByGoal(database, ownerId, [goal.id]);

    return toLearningGoalSnapshot(
      goal,
      activePlan?.id ?? null,
      inFlightByGoalId.get(goal.id) ?? NO_IN_FLIGHT_GENERATIONS,
    );
  }

  async findOwnedGoals(ownerId: string): Promise<LearningGoalListItemSnapshot[]> {
    const database = getDatabase();
    const goals = await database
      .select()
      .from(learningGoals)
      .where(eq(learningGoals.ownerId, ownerId))
      .orderBy(desc(learningGoals.updatedAt), desc(learningGoals.id));

    if (goals.length === 0) {
      return [];
    }

    const diagnosticAssessments = await database
      .select()
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, ownerId),
        eq(assessments.kind, "diagnostic"),
        inArray(assessments.goalId, goals.map((goal) => goal.id)),
      ))
      .orderBy(desc(assessments.createdAt), desc(assessments.id));

    const latestDiagnosticByGoalId = new Map<string, DiagnosticAssessmentRecord>();
    for (const assessment of diagnosticAssessments) {
      if (!latestDiagnosticByGoalId.has(assessment.goalId)) {
        latestDiagnosticByGoalId.set(assessment.goalId, assessment);
      }
    }

    const activePlans = await database
      .select({ id: learningPlans.id, goalId: learningPlans.goalId })
      .from(learningPlans)
      .where(and(
        eq(learningPlans.ownerId, ownerId),
        eq(learningPlans.status, "active"),
        inArray(learningPlans.goalId, goals.map((goal) => goal.id)),
      ));
    const activePlanIdByGoalId = new Map(activePlans.map((plan) => [plan.goalId, plan.id]));

    const inFlightByGoalId = await findInFlightGenerationsByGoal(
      database,
      ownerId,
      goals.map((goal) => goal.id),
    );

    return goals.map((goal) => ({
      ...toLearningGoalSnapshot(
        goal,
        activePlanIdByGoalId.get(goal.id) ?? null,
        inFlightByGoalId.get(goal.id) ?? NO_IN_FLIGHT_GENERATIONS,
      ),
      latestDiagnosticAssessment: toLatestDiagnosticAssessmentSnapshot(
        latestDiagnosticByGoalId.get(goal.id) ?? null,
      ),
    }));
  }

  async deleteOwnedGoal(
    ownerId: string,
    goalId: string,
  ): Promise<LearningGoalDeletionDecision> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      const [goal] = await transaction
        .select({ id: learningGoals.id })
        .from(learningGoals)
        .where(and(eq(learningGoals.id, goalId), eq(learningGoals.ownerId, ownerId)))
        .limit(1)
        .for("update");

      if (!goal) {
        return "not_found";
      }

      const [activeRun] = await transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(
          eq(agentRuns.ownerId, ownerId),
          eq(agentRuns.goalId, goal.id),
          inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES),
        ))
        .limit(1);

      if (activeRun) {
        return "has_active_runs";
      }

      const relatedRuns = await transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.ownerId, ownerId), eq(agentRuns.goalId, goal.id)));
      const relatedRunIds = relatedRuns.map((run) => run.id);

      if (relatedRunIds.length > 0) {
        await transaction
          .delete(outboxEvents)
          .where(and(
            eq(outboxEvents.aggregateType, "agent_run"),
            inArray(outboxEvents.aggregateId, relatedRunIds),
          ));
      }

      await transaction
        .delete(idempotencyKeys)
        .where(and(
          eq(idempotencyKeys.actorKey, ownerId),
          eq(idempotencyKeys.resourceType, "learning_goal"),
          eq(idempotencyKeys.resourceId, goal.id),
        ));

      await transaction
        .delete(learningGoals)
        .where(and(eq(learningGoals.id, goal.id), eq(learningGoals.ownerId, ownerId)));

      return "deleted";
    });
  }

  private async findExistingIdempotentGoal(
    transaction: Parameters<ReturnType<typeof getDatabase>["transaction"]>[0] extends (
      transaction: infer Transaction,
    ) => unknown ? Transaction : never,
    input: CreateLearningGoalInput & { profileVersion: number },
  ): Promise<CreateLearningGoalResult> {
    const [idempotencyRecord] = await transaction
      .select()
      .from(idempotencyKeys)
      .where(and(
        eq(idempotencyKeys.actorKey, input.ownerId),
        eq(idempotencyKeys.scope, IDEMPOTENCY_SCOPE),
        eq(idempotencyKeys.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);

    if (!idempotencyRecord || idempotencyRecord.requestHash !== input.requestHash) {
      throw new ProfileApplicationError("IDEMPOTENCY_CONFLICT");
    }
    if (idempotencyRecord.status !== "succeeded" || !idempotencyRecord.resourceId) {
      throw new Error("学习目标幂等请求尚未完成，无法返回确定结果。");
    }

    const [goal] = await transaction
      .select()
      .from(learningGoals)
      .where(and(
        eq(learningGoals.id, idempotencyRecord.resourceId),
        eq(learningGoals.ownerId, input.ownerId),
      ))
      .limit(1);

    if (!goal) {
      throw new Error("学习目标幂等记录指向的资源不存在。");
    }

    return { goal: toLearningGoalSnapshot(goal), created: false };
  }
}

function toLearnerProfileSnapshot(record: LearnerProfileRecord): LearnerProfileSnapshot {
  if (!isCurrentLevel(record.currentLevel)) {
    throw new Error("学习者画像包含不支持的当前水平。");
  }

  const preferences = record.preferencesJson as { contentPreference?: string };
  const rawContentPreference = preferences.contentPreference ?? "";
  const contentPreference = isContentPreference(rawContentPreference)
    ? rawContentPreference
    : "balanced";

  return {
    userId: record.userId,
    currentLevel: record.currentLevel,
    primaryLanguage: record.primaryLanguage,
    weeklyMinutes: record.weeklyMinutes,
    operatingSystem: record.operatingSystem,
    backgroundSummary: record.backgroundSummary,
    contentPreference,
    profileVersion: record.profileVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

interface GoalInFlightGenerations {
  planRunId: string | null;
  assessmentRunId: string | null;
}

const NO_IN_FLIGHT_GENERATIONS: GoalInFlightGenerations = { planRunId: null, assessmentRunId: null };

/**
 * 读取这些目标上仍在执行的生成任务 id（queued/running），按 run_type 归类为最新的一条。
 * 页面刷新后据此继续展示生成进度；每类同时最多一条在途。
 */
async function findInFlightGenerationsByGoal(
  database: ReturnType<typeof getDatabase>,
  ownerId: string,
  goalIds: string[],
): Promise<Map<string, GoalInFlightGenerations>> {
  const result = new Map<string, GoalInFlightGenerations>();
  if (goalIds.length === 0) {
    return result;
  }

  const runs = await database
    .select({ id: agentRuns.id, goalId: agentRuns.goalId, runType: agentRuns.runType })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.ownerId, ownerId),
      inArray(agentRuns.goalId, goalIds),
      inArray(agentRuns.runType, ["plan_generate", "assessment_generate"]),
      inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES),
    ))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));

  for (const run of runs) {
    const current = result.get(run.goalId) ?? { ...NO_IN_FLIGHT_GENERATIONS };
    if (run.runType === "plan_generate" && current.planRunId === null) {
      current.planRunId = run.id;
    }
    if (run.runType === "assessment_generate" && current.assessmentRunId === null) {
      current.assessmentRunId = run.id;
    }
    result.set(run.goalId, current);
  }

  return result;
}

function toLearningGoalSnapshot(
  record: LearningGoalRecord,
  activeLearningPlanId: string | null = null,
  inFlight: GoalInFlightGenerations = NO_IN_FLIGHT_GENERATIONS,
): LearningGoalSnapshot {
  if (!record.topic.trim() || !isLearningGoalStatus(record.status)) {
    throw new Error("学习目标包含不支持的主题或状态。");
  }

  return {
    id: record.id,
    ownerId: record.ownerId,
    topic: record.topic,
    title: record.title,
    description: record.description,
    desiredOutcome: record.desiredOutcome,
    targetDate: record.targetDate,
    weeklyMinutesOverride: record.weeklyMinutesOverride,
    modelConnectionId: record.modelConnectionId,
    profileVersion: record.profileVersion,
    status: record.status,
    activeLearningPlanId,
    latestPlanRunId: inFlight.planRunId,
    latestAssessmentRunId: inFlight.assessmentRunId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toLatestDiagnosticAssessmentSnapshot(
  record: DiagnosticAssessmentRecord | null,
): LatestDiagnosticAssessmentSnapshot | null {
  if (!record) {
    return null;
  }
  if (!isDiagnosticAssessmentStatus(record.status)) {
    throw new Error("数据库中存在不支持的前测状态。");
  }
  if (record.difficulty !== "normal" && record.difficulty !== "hard") {
    throw new Error("数据库中存在不支持的前测难度。");
  }

  return {
    id: record.id,
    status: record.status,
    questionCount: record.requestedQuestionCount,
    difficulty: record.difficulty,
    scorePercent: record.scorePercent === null ? null : Number(record.scorePercent),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
