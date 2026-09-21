/**
 * posttest_generate 节点后测生成工作流（单一 persona 的 ReAct 会话）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取固定节点内容上下文与账户默认模型连接 →
 * 解密凭据 → 在**唯一一个会话**里由模型基于节点内容与 teaching_memory 出题（可自由调用 tavily_search）→
 * 校验失败时由 ReAct 循环回灌字段路径自纠 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与改造前（三阶段 initial → repair → tavily_recovery）的差异：
 * - 全程只有一个人格（prompts/SYSTEM_PROMPT）；
 * - **产品边界变更（2026-09-18 用户确认）**：联网工具全程开放，由模型自主决定是否调用，
 *   节点内容与 teaching_memory 仍是主要出题依据，但事实不确定时允许联网核对；
 * - 轮数上限由 deps.reactMaxTurns 注入（默认 5，环境变量 AGENT_REACT_MAX_TURNS_POSTTEST）。
 *
 * 行为保持不变的契约：
 * - 内部接口调用顺序（先内容上下文、再默认模型连接、最后回写）、输入契约、输出摘要的 5 个键不变；
 * - 元数据键不变，取值语义映射同 assessment_generate；
 * - 结构类失败仍映射为 POSTTEST_OUTPUT_INVALID 并附带最多 8 条校验路径。
 *
 * 本目录文件划分：schema/ 输入合同、prompts/ 提示词；工作流主体（会话编排）在本文件。
 *
 * 导出：
 * - PosttestGenerationInputSchema / PosttestGenerationInput（转出 schema/）
 * - PosttestInternalPort / PosttestModelGatewayPort：工作流依赖的最小端口。
 * - PosttestGenerationDeps / PosttestGenerationResult。
 * - runPosttestGenerate：执行一次节点后测生成。
 * - PosttestGenerationWorkflowDeps / createPosttestGenerateWorkflow。
 */

import type { ToolGatewayPort } from '../../application/services/tool-aware-generator.js';
import { runReactAgentSession } from '../../application/services/tool-aware-generator.js';

import type { AgentWorkflow } from '../../application/commands/execute-agent-run.js';
import type { ModelCredentialDecryptor } from '../../infrastructure/llm/credential-decryptor.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelProviderConnection,
} from '../../infrastructure/llm/model-gateway.js';
import type {
  CardContentContextEnvelope,
  DefaultModelConnectionEnvelope,
  PersistedAssessmentEnvelope,
} from '../../schemas/core-internal.js';
import {
  recoveryStageLabel,
  validateQuestionSet,
} from '../shared/question-set-validation.js';
import { buildUserPrompt, buildValidationFeedback, serializeCardContentContext, SYSTEM_PROMPT } from './prompts/index.js';
import { PosttestGenerationInputSchema } from './schema/index.js';
export * from './schema/index.js';

/** 内部接口端口：工作流只依赖这三个方法。 */
export interface PosttestInternalPort {
  getCardContentContext(agentRunId: string): Promise<CardContentContextEnvelope>;
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistAssessment(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope>;
}

/** 模型网关端口：工作流只依赖 complete。 */
export interface PosttestModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface PosttestGenerationDeps {
  internalClient: PosttestInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: PosttestModelGatewayPort;
  /** 联网工具网关（Tavily）；未配置 Key 时返回受控错误而不是抛异常。 */
  toolGateway: ToolGatewayPort;
  /** 单次运行可见的工具调用上限。 */
  maxToolCalls: number;
  /** 本工作流的 ReAct 轮数上限（一次运行内允许的模型调用次数，含工具调用轮）。 */
  reactMaxTurns: number;
}

export interface PosttestGenerationResult {
  /** 与 Python 完全一致的 5 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/** 执行一次节点后测生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runPosttestGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: PosttestGenerationDeps,
): Promise<PosttestGenerationResult> {
  const parsedInput = PosttestGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('POSTTEST_INPUT_INVALID', '节点后测输入不符合契约。', false);
  }
  const generationInput = parsedInput.data;

  const context = await deps.internalClient.getCardContentContext(input.runId);
  const connectionEnvelope = await deps.internalClient.getDefaultModelConnection(input.runId);
  const apiKey = deps.decryptor.decrypt(connectionEnvelope.owner_id, connectionEnvelope.credential);
  const connection: ModelProviderConnection = {
    ownerId: connectionEnvelope.owner_id,
    connectionId: connectionEnvelope.connection_id,
    baseUrl: connectionEnvelope.base_url,
    modelId: connectionEnvelope.model_id,
    apiKey,
  };

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: buildUserPrompt(generationInput, serializeCardContentContext(context)),
    },
  ];

  const usage = { inputTokens: 0, outputTokens: 0 };
  const complete = async (request: ModelCompletionRequest): Promise<ModelCompletionResponse> => {
    const response = await deps.gateway.complete(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  };

  const outcome = await runReactAgentSession({
    complete,
    toolGateway: deps.toolGateway,
    maxTurns: deps.reactMaxTurns,
    maxToolCalls: deps.maxToolCalls,
    request: { agentRunId: input.runId, connection, messages },
    parse: (content) => validateQuestionSet(content, generationInput.question_count),
    buildFeedback: (feedbackContext) => buildValidationFeedback(feedbackContext),
    exhaustedErrorCode: 'POSTTEST_OUTPUT_INVALID',
    exhaustedMessage: '节点后测结果经过 ReAct 自纠后仍不符合题集合同。',
  });

  const questionSet = outcome.value;
  const recoveryStage = recoveryStageLabel(outcome);
  // 共享校验已按题量判定，这里是与 Python 对齐的兜底断言。
  if (questionSet.questions.length !== generationInput.question_count) {
    throw new ModelGatewayError(
      'POSTTEST_QUESTION_COUNT_INVALID',
      '节点后测题目数量与请求不一致。',
      false,
    );
  }

  const persisted = await deps.internalClient.persistAssessment(input.runId, {
    kind: generationInput.kind,
    question_count: generationInput.question_count,
    difficulty: generationInput.difficulty,
    plan_id: null,
    plan_node_id: generationInput.plan_node_id,
    source_card_content_id: generationInput.source_card_content_id,
    schema_version: questionSet.schema_version,
    questions: questionSet.questions.map((question) => ({
      prompt: question.prompt,
      options: question.options.map((option) => ({ key: option.key, text: option.text })),
      answer_key: question.answer_key,
      explanation: question.explanation,
      skill_tags: question.skill_tags,
      max_score: question.max_score,
    })),
    generation_metadata: {
      model_id: connection.modelId,
      source_card_content_id: generationInput.source_card_content_id,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: recoveryStage,
    },
  });

  return {
    outputSummary: {
      assessment_id: persisted.assessment_id,
      question_count: persisted.question_count,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: recoveryStage,
      model_id: connection.modelId,
    },
    usage,
  };
}

/**
 * 把节点后测工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type PosttestGenerationWorkflowDeps = Omit<PosttestGenerationDeps, 'toolGateway'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
};

export function createPosttestGenerateWorkflow(deps: PosttestGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runPosttestGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        { ...deps, toolGateway: deps.createToolGateway(executionState.ownerId) },
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
