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

const GRAPH_VERSION = "plan_generate.v1";
const PROMPT_VERSION = "plan_generate.v1";
const INPUT_SCHEMA_VERSION = "plan_generate.input.v1";
const OUTPUT_SCHEMA_VERSION = "learning_plan.v1";
const REQUESTED_MODEL_PROFILE = "account_default_openai_compatible";

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

    return this.agentRunRequester.request({
      ownerId: input.ownerId,
      goalId: context.goalId,
      runType: "plan_generate",
      targetType: "learning_goal",
      targetId: context.goalId,
      idempotencyKey: input.idempotencyKey,
      graphVersion: GRAPH_VERSION,
      promptVersion: PROMPT_VERSION,
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      requestedModelProfile: REQUESTED_MODEL_PROFILE,
      inputSummaryJson: inputSnapshot,
    });
  }
}