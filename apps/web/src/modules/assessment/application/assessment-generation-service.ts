/**
 * Assessment 生成应用服务。
 *
 * 导出：
 * - AssessmentGenerationService：校验目标上下文并创建前测 assessment_generate AgentRun。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

import {
  AssessmentGenerationApplicationError,
  type AssessmentGenerationAgentRunRequester,
  type AssessmentGenerationContextRepository,
  type AssessmentGenerationRequest,
} from "../domain/assessment-generation";

const GRAPH_VERSION = "assessment_generate.v1";
const PROMPT_VERSION = "assessment_generate.v1";
const INPUT_SCHEMA_VERSION = "assessment_generate.input.v1";
const OUTPUT_SCHEMA_VERSION = "assessment.single_choice.v1";
const REQUESTED_MODEL_PROFILE = "account_default_openai_compatible";

export class AssessmentGenerationService {
  constructor(
    private readonly contextRepository: AssessmentGenerationContextRepository,
    private readonly agentRunRequester: AssessmentGenerationAgentRunRequester,
  ) {}

  async request(input: AssessmentGenerationRequest): Promise<AgentRunProductionResult> {
    const context = await this.contextRepository.findOwnedGoalContext(input.ownerId, input.goalId);
    if (!context) {
      throw new AssessmentGenerationApplicationError("LEARNING_GOAL_NOT_FOUND");
    }

    if (!await this.contextRepository.hasDefaultModelConnection(input.ownerId)) {
      throw new AssessmentGenerationApplicationError("DEFAULT_MODEL_CONNECTION_REQUIRED");
    }

    return this.agentRunRequester.request({
      ownerId: input.ownerId,
      goalId: input.goalId,
      runType: "assessment_generate",
      targetType: "learning_goal",
      targetId: input.goalId,
      idempotencyKey: input.idempotencyKey,
      graphVersion: GRAPH_VERSION,
      promptVersion: PROMPT_VERSION,
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      requestedModelProfile: REQUESTED_MODEL_PROFILE,
      inputSummaryJson: {
        topic: context.topic,
        title: context.title,
        description: context.description,
        desired_outcome: context.desiredOutcome,
        background: context.backgroundSummary,
        overall_experience: context.overallExperience,
        question_count: input.questionCount,
        difficulty: input.difficulty,
        kind: input.kind,
      },
    });
  }
}
