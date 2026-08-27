/**
 * 节点知识内容生成应用服务。
 *
 * 导出：
 * - CardContentGenerationService：校验节点和内容状态，创建 card_content_generate AgentRun。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

import {
  CardContentGenerationApplicationError,
  type CardContentGenerationAgentRunRequester,
  type CardContentGenerationContextRepository,
  type CardContentGenerationRequest,
} from "../domain/content-generation";

const GRAPH_VERSION = "card_content_generate.v1";
const PROMPT_VERSION = "card_content_generate.v1";
const INPUT_SCHEMA_VERSION = "card_content_generate.input.v1";
const OUTPUT_SCHEMA_VERSION = "card_content.v1";
const REQUESTED_MODEL_PROFILE = "account_default_openai_compatible";

export class CardContentGenerationService {
  constructor(
    private readonly contextRepository: CardContentGenerationContextRepository,
    private readonly agentRunRequester: CardContentGenerationAgentRunRequester,
  ) {}

  async request(input: CardContentGenerationRequest): Promise<AgentRunProductionResult> {
    const context = await this.contextRepository.findOwnedNodeContext(
      input.ownerId,
      input.planNodeId,
    );
    if (!context) {
      throw new CardContentGenerationApplicationError("PLAN_NODE_NOT_FOUND");
    }
    if (context.contentStatus === "ready") {
      throw new CardContentGenerationApplicationError("CARD_CONTENT_ALREADY_AVAILABLE");
    }
    if (context.contentStatus === "generating") {
      throw new CardContentGenerationApplicationError("CARD_CONTENT_GENERATION_IN_PROGRESS");
    }
    if (!await this.contextRepository.hasDefaultModelConnection(input.ownerId)) {
      throw new CardContentGenerationApplicationError("DEFAULT_MODEL_CONNECTION_REQUIRED");
    }

    return this.agentRunRequester.request({
      ownerId: input.ownerId,
      goalId: context.goalId,
      runType: "card_content_generate",
      targetType: "plan_node",
      targetId: context.planNodeId,
      idempotencyKey: input.idempotencyKey,
      graphVersion: GRAPH_VERSION,
      promptVersion: PROMPT_VERSION,
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      requestedModelProfile: REQUESTED_MODEL_PROFILE,
      inputSummaryJson: {
        agent_role: "node_tutor",
        logical_session_key: "node:" + context.planNodeId,
        goal: {
          id: context.goalId,
          topic: context.topic,
          title: context.goalTitle,
          desired_outcome: context.desiredOutcome,
        },
        learner_profile: {
          profile_version: context.profileVersion,
          current_level: context.currentLevel,
          weekly_minutes: context.weeklyMinutes,
          background_summary: context.backgroundSummary,
        },
        learning_plan: {
          id: context.planId,
        },
        plan_node: {
          id: context.planNodeId,
          node_key: context.nodeKey,
          title: context.nodeTitle,
          node_brief: context.nodeBrief,
          learning_objective: context.learningObjective,
          rationale: context.rationale,
          difficulty: context.difficulty,
          estimated_minutes: context.estimatedMinutes,
          completion_criteria: context.completionCriteria,
        },
      },
    });
  }
}