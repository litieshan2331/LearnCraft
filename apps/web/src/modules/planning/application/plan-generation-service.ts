/**
 * 学习路线生成应用服务。
 *
 * 导出：
 * - PlanGenerationService：在前测评分完成后创建 plan_generate AgentRun。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

import {
  PlanGenerationApplicationError,
  type PlanGenerationAgentRunRequester,
  type PlanGenerationContextRepository,
  type PlanGenerationRequest,
} from "../domain/plan-generation";

const PROMPT_VERSION = "plan_generate.v1";
const INPUT_SCHEMA_VERSION = "plan_generate.input.v1";
const OUTPUT_SCHEMA_VERSION = "learning_plan.v1";
const REQUESTED_MODEL_PROFILE = "account_default_openai_compatible";

/** 读取 Web 侧学习路线 HITL 开关；缺省保持当前启用行为，显式值只能是 true/false。 */
export function readPlanHumanReviewEnabled(): boolean {
  const raw = process.env.AGENT_PLAN_HUMAN_REVIEW_ENABLED?.trim();
  if (raw === undefined || raw.length === 0) return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("环境变量 AGENT_PLAN_HUMAN_REVIEW_ENABLED 必须是 true 或 false。");
}

export class PlanGenerationService {
  constructor(
    private readonly contextRepository: PlanGenerationContextRepository,
    private readonly agentRunRequester: PlanGenerationAgentRunRequester,
  ) {}

  async request(input: PlanGenerationRequest): Promise<AgentRunProductionResult> {
    const context = await this.contextRepository.findOwnedReadyContext(
      input.ownerId,
      input.goalId,
    );
    if (!context) {
      throw new PlanGenerationApplicationError("PLAN_GENERATION_PREREQUISITES_NOT_MET");
    }

    if (!await this.contextRepository.hasDefaultModelConnection(input.ownerId)) {
      throw new PlanGenerationApplicationError("DEFAULT_MODEL_CONNECTION_REQUIRED");
    }

    // 目标级幂等：该目标已有在途的 plan_generate 任务时直接返回它，
    // 避免连点两次生成两份路线（后一份会把前一份置为 superseded）。
    const inFlight = await this.agentRunRequester.findInFlightRun({
      ownerId: input.ownerId,
      runType: "plan_generate",
      targetType: "learning_goal",
      targetId: context.goalId,
    });
    if (inFlight) {
      return { agentRun: inFlight, created: false };
    }

    const inputSnapshot = {
      goal: {
        id: context.goalId,
        topic: context.topic,
        title: context.title,
        description: context.description,
        desired_outcome: context.desiredOutcome,
      },
      learner_profile: {
        profile_version: context.profileVersion,
        current_level: context.currentLevel,
        weekly_minutes: context.weeklyMinutes,
        background_summary: context.backgroundSummary,
      },
      diagnostic_assessment: {
        assessment_id: context.assessmentId,
        score_percent: context.assessmentScorePercent,
        mastery_summary: context.assessmentMasterySummary,
      },
    };
    const humanReviewEnabled = readPlanHumanReviewEnabled();

    return this.agentRunRequester.request({
      ownerId: input.ownerId,
      goalId: context.goalId,
      runType: "plan_generate",
      targetType: "learning_goal",
      targetId: context.goalId,
      idempotencyKey: input.idempotencyKey,
      graphVersion: humanReviewEnabled ? "plan_generate.hitl.v1" : "plan_generate.v1",
      promptVersion: PROMPT_VERSION,
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      requestedModelProfile: REQUESTED_MODEL_PROFILE,
      modelConnectionId: context.modelConnectionId ?? null,
      inputSummaryJson: inputSnapshot,
    });
  }
}
