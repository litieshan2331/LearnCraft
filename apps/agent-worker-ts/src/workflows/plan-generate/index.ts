/**
 * plan_generate 学习路线生成工作流（单一 persona 的 ReAct 会话）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 在**唯一一个会话**里由模型生成章节式学习路线（可自由调用 tavily_search 获取资料）→
 * 校验失败时由 ReAct 循环把字段路径回灌同一会话让模型自纠 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与改造前（首轮 + 两次修复 + 强制联网兜底重建）的差异：
 * - 全程只有一个人格（prompts/SYSTEM_PROMPT），不再按阶段重建消息列表、不再强制 Tavily 检索与断网降级人格；
 * - 联网工具由模型在会话内自主决定是否调用（非强制）；
 * - 轮数上限由 deps.reactMaxTurns 注入（默认 10，环境变量 AGENT_REACT_MAX_TURNS_PLAN）；
 * - 会话内解析保留原兜底阶段的宽松能力：严格校验失败后先经 recovery/ 的宽松规范化再严格校验，
 *   因此模型给出旧字段名、字符串难度等松散结构时仍有自纠机会。
 *
 * 行为保持不变的契约：
 * - 输入契约、路线合同（node_key 唯一、ordinal 连续、依赖存在且无环）与摘要的 6 个键不变；
 * - 元数据键不变，取值按语义映射：
 *   repair_attempts = 首次通过校验前的失败次数（0 表示首轮即通过）；
 *   generation_path = 用过工具且自纠过 → tavily_recovery；用过工具未自纠 → model_with_tavily；未用工具 → model_knowledge；
 *   fallback_used = 是否发生过自纠（等价于原「走了恢复路径」）；
 * - token 用量仍写真实值，由调用方写入 agent_runs 的 token 列。
 *
 * 本目录文件划分：schema/ 输入与路线合同、prompts/ 提示词、recovery/ 兜底宽松规范化；
 * 工作流主体（会话编排与元数据映射）在本文件。
 *
 * 导出：
 * - PlanGenerationInputSchema / PlanGenerationInput（转出 schema/）
 * - PLAN_GENERATION_PATHS / planGenerationPath：generation_path 的取值集合与映射函数。
 * - PlanInternalPort / PlanModelGatewayPort：工作流依赖的最小端口。
 * - PlanGenerationDeps / PlanGenerationResult。
 * - runPlanGenerate：执行一次学习路线生成。
 * - PlanGenerationWorkflowDeps / createPlanGenerateWorkflow。
 */

import type { ToolGatewayPort } from '../../application/services/tool-aware-generator.js';
import { runReactAgentSession } from '../../application/services/tool-aware-generator.js';
import {
  appendLearningSkillsToToolSection,
  type LearningSkillsPort,
} from '../../application/services/learning-skills.js';
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
  type ModelProviderConnection,
} from '../../infrastructure/llm/model-gateway.js';
import { extractJsonText } from '../../schemas/assessment-question-set.js';
import type {
  DefaultModelConnectionEnvelope,
  PersistedLearningPlanEnvelope,
} from '../../schemas/core-internal.js';
import { buildUserPrompt, buildValidationFeedback, SYSTEM_PROMPT } from './prompts/index.js';
import {
  LearningPlanDocumentSchema,
  planValidationPaths,
  type LearningPlanDocument,
} from './schema/index.js';
import { PlanRecoveryNormalizationError, normalizeRecoveryDocument } from './recovery/index.js';
import { PlanGenerationInputSchema } from './schema/index.js';
import type { TraceWriter } from '../../application/services/trace-writer.js';
export * from './schema/index.js';

/** 路线输出的解析结果：通过时给出文档，失败时给出脱敏字段路径。 */
interface PlanParseResult {
  value: LearningPlanDocument | null;
  paths: string[];
}

/** 严格解析：剥离围栏 → JSON → 路线合同。 */
function parseStrictPlan(content: string): PlanParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch {
    return { value: null, paths: ['response.json'] };
  }
  const parsed = LearningPlanDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { value: null, paths: planValidationPaths(parsed.error) };
  }
  return { value: parsed.data, paths: [] };
}

/** 宽松规范化后再严格校验（等价于原兜底恢复阶段的处理，不放宽合同）。 */
function parseNormalizedPlan(content: string): PlanParseResult {
  try {
    const normalized = normalizeRecoveryDocument(extractJsonText(content));
    const parsed = LearningPlanDocumentSchema.safeParse(normalized);
    if (parsed.success) {
      return { value: parsed.data, paths: [] };
    }
    return { value: null, paths: planValidationPaths(parsed.error) };
  } catch (error) {
    return {
      value: null,
      paths: error instanceof PlanRecoveryNormalizationError ? [error.path] : ['response.json'],
    };
  }
}

/** 会话内解析：先严格校验，再尝试宽松规范化；两条路径都失败时返回更具体的字段路径。 */
function parsePlanDocument(content: string): PlanParseResult {
  const strict = parseStrictPlan(content);
  if (strict.value !== null) {
    return strict;
  }
  const normalized = parseNormalizedPlan(content);
  if (normalized.value !== null) {
    return normalized;
  }
  return { value: null, paths: strict.paths.length > 0 ? strict.paths : normalized.paths };
}

/** generation_path 的取值集合（与改造前一致，Web 无需改动）。 */
export const PLAN_GENERATION_PATHS = ['model_knowledge', 'model_with_tavily', 'tavily_recovery'] as const;

/**
 * 把 ReAct 会话结果映射为语义兼容的 generation_path：
 * 未用工具 → model_knowledge；用过工具且首答即通过 → model_with_tavily；
 * 用过工具且经过自纠 → tavily_recovery（等价于原「联网恢复路径」）。
 */
export function planGenerationPath(outcome: {
  toolCallCount: number;
  validationFailures: number;
}): (typeof PLAN_GENERATION_PATHS)[number] {
  if (outcome.toolCallCount === 0) {
    return 'model_knowledge';
  }
  return outcome.validationFailures > 0 ? 'tavily_recovery' : 'model_with_tavily';
}

/** 内部接口端口：工作流只依赖这两个方法。 */
export interface PlanInternalPort {
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistLearningPlan(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedLearningPlanEnvelope>;
}

/** 模型网关端口：工作流只依赖 complete。 */
export interface PlanModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface PlanGenerationDeps {
  internalClient: PlanInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: PlanModelGatewayPort;
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
  /** 按工作流分层加载的教学 Skill；未提供时保持旧提示词行为。 */
  learningSkills?: LearningSkillsPort;
}

export interface PlanGenerationResult {
  /** 与 Python 完全一致的 6 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/** 执行一次学习路线生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runPlanGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: PlanGenerationDeps,
): Promise<PlanGenerationResult> {
  const parsedInput = PlanGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('PLAN_INPUT_INVALID', '学习路线生成输入不符合契约。', false);
  }
  const value = parsedInput.data;
  const progress = deps.progress ?? createNoopAgentProgressReporter();

  progress.report('run.preparing');
  const connectionEnvelope = await deps.internalClient.getDefaultModelConnection(input.runId);
  const apiKey = deps.decryptor.decrypt(connectionEnvelope.owner_id, connectionEnvelope.credential);
  const connection: ModelProviderConnection = {
    ownerId: connectionEnvelope.owner_id,
    connectionId: connectionEnvelope.connection_id,
    baseUrl: connectionEnvelope.base_url,
    modelId: connectionEnvelope.model_id,
    apiKey,
  };

  const usage = { inputTokens: 0, outputTokens: 0 };
  const complete = async (request: ModelCompletionRequest): Promise<ModelCompletionResponse> => {
    const response = await deps.gateway.complete(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  };

  const messages = [
    {
      role: 'system' as const,
      content: appendLearningSkillsToToolSection(
        SYSTEM_PROMPT,
        deps.learningSkills?.buildPromptSection('plan_generate') ?? '',
      ),
    },
    { role: 'user' as const, content: buildUserPrompt(value) },
  ];

  const outcome = await runReactAgentSession({
    complete,
    toolGateway: deps.toolGateway,
    maxTurns: deps.reactMaxTurns,
    maxToolCalls: deps.maxToolCalls,
    request: { agentRunId: input.runId, connection, messages },
    parse: parsePlanDocument,
    buildFeedback: (context) => buildValidationFeedback(context),
    exhaustedErrorCode: 'PLAN_MODEL_RECOVERY_INVALID',
    exhaustedMessage: '学习路线经过 ReAct 自纠后仍不符合路线合同。',
    onProgress: progress,
    traceWriter: deps.traceWriter,
  });

  const plan = outcome.value;
  const toolCallCount = outcome.toolCallCount;
  const repairAttempts = outcome.validationFailures;
  const generationPath = planGenerationPath(outcome);
  const fallbackUsed = outcome.validationFailures > 0;

  progress.report('result.persisting');
  const persisted = await deps.internalClient.persistLearningPlan(input.runId, {
    ...plan,
    generation_metadata: {
      model_id: connection.modelId,
      tool_call_count: toolCallCount,
      repair_attempts: repairAttempts,
      generation_path: generationPath,
      fallback_used: fallbackUsed,
    },
  });

  progress.report('run.completed', {
    node_count: persisted.node_count,
    tool_call_count: toolCallCount,
    generation_path: generationPath,
  });

  return {
    outputSummary: {
      learning_plan_id: persisted.learning_plan_id,
      node_count: persisted.node_count,
      tool_call_count: toolCallCount,
      repair_attempts: repairAttempts,
      generation_path: generationPath,
      model_id: connection.modelId,
    },
    usage,
  };
}

/**
 * 把路线生成工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type PlanGenerationWorkflowDeps = Omit<PlanGenerationDeps, 'toolGateway' | 'progress'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
  /** 为一次运行创建进度上报器；缺省时使用空实现（不启用实时进度）。 */
  createProgressReporter?: (runId: string) => AgentProgressReporter;
};

export function createPlanGenerateWorkflow(deps: PlanGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runPlanGenerate(
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
