/**
 * assessment_generate 前测题集生成工作流（单一 persona 的 ReAct 会话）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 在**唯一一个会话**里由模型自主生成题集（可自由调用 tavily_search），
 * 校验失败时由 ReAct 循环把字段路径回灌同一会话让模型自纠 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与改造前（三阶段 initial → repair → tavily_recovery）的差异：
 * - 全程只有一个人格（prompts/SYSTEM_PROMPT），不再按阶段重建消息列表、不再追加上一轮原文与修复指令；
 * - 联网工具不再按阶段开关，整个会话内由模型自主决定是否调用（非强制）；
 * - 轮数上限由 deps.reactMaxTurns 注入（默认 5，环境变量 AGENT_REACT_MAX_TURNS_ASSESSMENT）；
 * - token 用量仍写真实值，由调用方写入 agent_runs 的 token 列。
 *
 * 行为保持不变的契约：
 * - 输入契约、题集合同、幂等回写载荷与输出摘要的 6 个键不变；
 * - 元数据键不变，取值按语义映射：用过联网工具 → recovery_stage=tavily_recovery；
 *   未用工具且首轮通过 → initial；同一会话内自纠后通过 → repair；
 * - 题目数量、选项与 answer_key 的约束仍由 zod 合同硬校验。
 *
 * 本目录文件划分：schema/ 输入合同、prompts/ 提示词；工作流主体（会话编排）在本文件。
 *
 * 导出：
 * - AssessmentGenerationInputSchema / AssessmentGenerationInput（转出 schema/）
 * - AssessmentInternalPort / AssessmentModelGatewayPort：工作流依赖的最小端口。
 * - AssessmentGenerationDeps / AssessmentGenerationResult。
 * - runAssessmentGenerate：执行一次前测生成。
 * - AssessmentGenerationWorkflowDeps / createAssessmentGenerateWorkflow。
 */

import type { ToolGatewayPort } from '../../application/services/tool-aware-generator.js';
import { runReactAgentSession } from '../../application/services/tool-aware-generator.js';
import {
  createNoopAgentProgressReporter,
  type AgentProgressReporter,
} from '../../application/services/agent-progress.js';

import type { AgentWorkflow } from '../../application/commands/execute-agent-run.js';
import type { ModelCredentialDecryptor } from '../../infrastructure/llm/credential-decryptor.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
} from '../../infrastructure/llm/model-gateway.js';
import type { DefaultModelConnectionEnvelope, PersistedAssessmentEnvelope } from '../../schemas/core-internal.js';
import {
  recoveryStageLabel,
  searchExtractLabel,
  validateQuestionSet,
} from '../shared/question-set-validation.js';
import { buildUserPrompt, buildValidationFeedback, SYSTEM_PROMPT } from './prompts/index.js';
import { AssessmentGenerationInputSchema } from './schema/index.js';
import type { TraceWriter } from '../../application/services/trace-writer.js';
export * from './schema/index.js';

/** 内部接口端口：工作流只依赖这两个方法。 */
export interface AssessmentInternalPort {
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistAssessment(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope>;
}

/** 模型网关端口：工作流只依赖 complete。 */
export interface AssessmentModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface AssessmentGenerationDeps {
  internalClient: AssessmentInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: AssessmentModelGatewayPort;
  /** 联网工具网关（Tavily）；未配置 Key 时返回受控错误而不是抛异常。 */
  toolGateway: ToolGatewayPort;
  /** 单次运行可见的工具调用上限。 */
  maxToolCalls: number;
  /** 本工作流的 ReAct 轮数上限（一次运行内允许的模型调用次数，含工具调用轮）。 */
  reactMaxTurns: number;
  /** 可选的实时进度上报端口（生成过程中的步骤/工具事件，不落库、不含模型原文）。 */
  progress?: AgentProgressReporter;
  /** 完整模型与工具观测写入端口。 */
  traceWriter?: TraceWriter;
}

export interface AssessmentGenerationResult {
  /** 与 Python 完全一致的 6 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/** 执行一次前测生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runAssessmentGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: AssessmentGenerationDeps,
): Promise<AssessmentGenerationResult> {
  const parsedInput = AssessmentGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('ASSESSMENT_INPUT_INVALID', '题集生成输入不符合契约。', false);
  }
  const generationInput = parsedInput.data;
  const progress = deps.progress ?? createNoopAgentProgressReporter();

  progress.report('run.preparing');
  const connection = await deps.internalClient.getDefaultModelConnection(input.runId);
  const apiKey = deps.decryptor.decrypt(connection.owner_id, connection.credential);
  const modelConnection = {
    ownerId: connection.owner_id,
    connectionId: connection.connection_id,
    baseUrl: connection.base_url,
    modelId: connection.model_id,
    apiKey,
  };

  const messages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(generationInput) },
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
    request: { agentRunId: input.runId, connection: modelConnection, messages },
    parse: (content) => validateQuestionSet(content, generationInput.question_count),
    buildFeedback: (context) => buildValidationFeedback(context),
    exhaustedErrorCode: 'MODEL_STRUCTURED_OUTPUT_INVALID',
    exhaustedMessage: '题集结果经过 ReAct 自纠后仍不符合题集合同。',
    onProgress: progress,
    traceWriter: deps.traceWriter,
  });

  const questionSet = outcome.value;
  const recoveryStage = recoveryStageLabel(outcome);

  progress.report('result.persisting', { question_count: generationInput.question_count });
  const persisted = await deps.internalClient.persistAssessment(input.runId, {
    kind: generationInput.kind,
    question_count: generationInput.question_count,
    difficulty: generationInput.difficulty,
    plan_id: null,
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
      topic: generationInput.topic,
      model_id: connection.model_id,
      tool_call_count: outcome.toolCallCount,
      search_extract: searchExtractLabel(outcome.toolCallCount),
      recovery_stage: recoveryStage,
    },
  });

  progress.report('run.completed', {
    question_count: persisted.question_count,
    tool_call_count: outcome.toolCallCount,
    recovery_stage: recoveryStage,
  });

  return {
    outputSummary: {
      assessment_id: persisted.assessment_id,
      status: persisted.status,
      question_count: persisted.question_count,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: recoveryStage,
      model_id: connection.model_id,
    },
    usage,
  };
}

/**
 * 把前测工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type AssessmentGenerationWorkflowDeps = Omit<AssessmentGenerationDeps, 'toolGateway' | 'progress'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
  /** 为一次运行创建进度上报器；缺省时使用空实现（不启用实时进度）。 */
  createProgressReporter?: (runId: string) => AgentProgressReporter;
};

export function createAssessmentGenerateWorkflow(deps: AssessmentGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runAssessmentGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        {
          ...deps,
          toolGateway: deps.createToolGateway(executionState.ownerId),
          ...(deps.createProgressReporter === undefined
            ? {}
            : { progress: deps.createProgressReporter(executionState.runId) }),
        },
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
