/**
 * 节点后测生成应用服务。
 *
 * 导出：
 * - PosttestGenerationService：校验节点归属、唯一成功内容和默认模型，并创建 posttest_generate AgentRun。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

import {
  PosttestGenerationApplicationError,
  type PosttestGenerationAgentRunRequester,
  type PosttestGenerationContextRepository,
  type PosttestGenerationRequest,
} from "../domain/posttest-generation";

const GRAPH_VERSION = "posttest_generate.v1";
const PROMPT_VERSION = "posttest_generate.v1";
const INPUT_SCHEMA_VERSION = "posttest_generate.input.v1";
const OUTPUT_SCHEMA_VERSION = "assessment.single_choice.v1";
const REQUESTED_MODEL_PROFILE = "account_default_openai_compatible";

export class PosttestGenerationService {
  constructor(
    private readonly contextRepository: PosttestGenerationContextRepository,
    private readonly agentRunRequester: PosttestGenerationAgentRunRequester,
  ) {}

  async request(input: PosttestGenerationRequest): Promise<AgentRunProductionResult> {
    const context = await this.contextRepository.findOwnedNodeContext(
      input.ownerId,
      input.planNodeId,
    );
    if (!context) {
      throw new PosttestGenerationApplicationError("PLAN_NODE_NOT_FOUND");
    }

    if (!context.cardContentId) {
      throw new PosttestGenerationApplicationError("CARD_CONTENT_NOT_READY");
    }

    const availability = await this.contextRepository.getGenerationAvailability(
      input.ownerId,
      input.planNodeId,
    );
    if (availability === "active") {
      // 目标级幂等：已有在途任务时返回它（不再报错），前端据此接上同一个任务的进度流。
      const inFlight = await this.agentRunRequester.findInFlightRun({
        ownerId: input.ownerId,
        runType: "posttest_generate",
        targetType: "plan_node",
        targetId: context.planNodeId,
      });
      if (inFlight) {
        return { agentRun: inFlight, created: false };
      }
      throw new PosttestGenerationApplicationError("POSTTEST_GENERATION_IN_PROGRESS");
    }
    if (availability === "awaiting_attempt") {
      throw new PosttestGenerationApplicationError("POSTTEST_ATTEMPT_REQUIRED");
    }

    if (!await this.contextRepository.hasDefaultModelConnection(input.ownerId)) {
      throw new PosttestGenerationApplicationError("DEFAULT_MODEL_CONNECTION_REQUIRED");
    }

    return this.agentRunRequester.request({
      ownerId: input.ownerId,
      goalId: context.goalId,
      runType: "posttest_generate",
      targetType: "plan_node",
      targetId: context.planNodeId,
      idempotencyKey: input.idempotencyKey,
      graphVersion: GRAPH_VERSION,
      promptVersion: PROMPT_VERSION,
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
      requestedModelProfile: REQUESTED_MODEL_PROFILE,
      inputSummaryJson: {
        topic: context.topic,
        question_count: input.questionCount,
        difficulty: input.difficulty,
        kind: "post_test",
        plan_node_id: context.planNodeId,
        source_card_content_id: context.cardContentId,
      },
    });
  }
}