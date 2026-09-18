/**
 * plan_generate 学习路线生成工作流（等价于 Python 的 workflows/plan_generate.py）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 生成章节式学习路线 → 严格校验与两次修复 → 兜底重建 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与 Python 逐项对齐的行为：
 * - 输入契约：三层嵌套对象都是 extra=forbid，weekly_minutes 30-10080，background_summary 可空；
 * - 提示词：system 与 user 文案一致，前测薄弱点摘要按原字段顺序序列化后嵌入；
 * - 校验与修复：首轮 + 两次修复（repair_attempts 取 0/1/2），修复消息为
 *   「原文 assistant 消息 + 修复指令 system 消息」，全部失败后进入兜底重建；
 * - 兜底重建：先强制 Tavily 检索后重建，联网不可用时退回无资料重建；
 *   两条路径都使用 plan-recovery.ts 的宽松规范化后再严格校验，失败时再做一次结构化修复；
 * - 回写载荷与输出摘要字段与 Python 一致（6 个摘要键，generation_path 取
 *   model_knowledge / tavily_recovery）。
 *
 * **已确认的行为差异：** token 用量写真实值（Python 的 mark_succeeded 恒写 0），
 * 由调用方写入 agent_runs 的 token 列；本工作流累计首轮、修复与兜底所有模型调用的用量。
 *
 * 联网工具（Tavily 远程 MCP）已接入：首轮由模型自主决定是否调用，工具调用数写入
 * generation_metadata；全部严格校验失败后先执行 _rebuild_with_tavily（强制联网检索后重建），
 * 联网不可用时再退回 _rebuild_without_sources，两条路径都通过同一份路线合同。
 *
 * 导出：
 * - PlanGenerationInputSchema / PlanGenerationInput
 * - PlanInternalPort / PlanModelGatewayPort：工作流依赖的最小端口。
 * - PlanGenerationDeps / PlanGenerationResult。
 * - runPlanGenerate：执行一次学习路线生成。
 * - createPlanGenerateWorkflow：适配为注册表可用的 AgentWorkflow。
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AgentWorkflow } from '../application/commands/execute-agent-run.js';
import type { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
  type ModelProviderConnection,
} from '../infrastructure/llm/model-gateway.js';
import { extractJsonText } from '../schemas/assessment-question-set.js';
import type {
  DefaultModelConnectionEnvelope,
  PersistedLearningPlanEnvelope,
} from '../schemas/core-internal.js';
import {
  runToolAwareGeneration,
  type ToolGatewayPort,
} from '../application/services/tool-aware-generator.js';
import { TAVILY_SEARCH_TOOL } from '../infrastructure/mcp/tavily-tool-gateway.js';
import {
  LearningPlanDocumentSchema,
  planValidationPaths,
  type LearningPlanDocument,
} from './plan-document.js';
import { PlanRecoveryNormalizationError, normalizeRecoveryDocument } from './plan-recovery.js';

/** 联网工具未配置或不可用时的占位错误类别；正常路径会回填工具返回的真实类别。 */
const TAVILY_UNAVAILABLE_CODE = 'TAVILY_TOOL_NOT_AVAILABLE';

const SYSTEM_PROMPT = [
  '你是 LearnCraft 的学习路线规划师。你只生成学习路线，不生成知识正文或题目。',
  '最终必须只输出一个严格 JSON 对象，不能输出 Markdown 或额外解释。',
  '路线必须像一本技术书的章节目录：6 到 12 个可独立学习的主题章节，不能使用泛化的“了解概念、练习、复盘”阶段模板。',
  '所有面向学习者的文字必须使用简体中文；技术专有名词、代码和标识符可保留英文。',
  '当主题涉及近期版本、快速变化 API、兼容性或你对事实没有足够把握时，可以使用 tavily_search。',
  '对于稳定且有把握的知识可直接生成；不要为调用工具而调用工具。',
  'JSON 顶层只能包含 schema_version、title、summary、nodes。',
  '每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria。',
  'node_key 使用小写英文和下划线，ordinal 必须从 1 连续编号。',
  '依赖只能指向当前 nodes 中已存在的 node_key，依赖图必须无环。',
].join('');

const ROUTE_REPAIR_INSTRUCTION =
  '上一轮路线不符合输出 Schema 或章节依赖规则。'
  + '请只输出修复后的严格合法 JSON；不得输出额外文字，也不得调用工具。';

const RECOVERY_SYSTEM_PROMPT = [
  'Tavily 联网兜底暂时不可用。请仅使用你已有的稳定知识，严格按 schema_version、title、summary、nodes 输出；',
  '每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；',
  '禁止 description、topics、goal、dependencies 等旧字段；路线必须有 6-12 个章节、ordinal 连续、依赖存在且无环。',
  '不要调用工具，不要输出额外文字。',
].join('');

export const PlanGenerationInputSchema = z
  .object({
    goal: z
      .object({
        id: z.string().min(1).max(64),
        topic: z.string().min(1).max(300),
        title: z.string().min(1).max(300),
        description: z.string().min(1).max(2_000),
        desired_outcome: z.string().min(1).max(2_000),
      })
      .strict(),
    learner_profile: z
      .object({
        profile_version: z.number().int().min(1),
        current_level: z.enum(['beginner', 'intermediate', 'advanced']),
        weekly_minutes: z.number().int().min(30).max(10_080),
        background_summary: z.string().max(4_000).nullish(),
      })
      .strict(),
    diagnostic_assessment: z
      .object({
        assessment_id: z.string().min(1).max(64),
        score_percent: z.number().min(0).max(100),
        mastery_summary: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  })
  .strict();

export type PlanGenerationInput = z.infer<typeof PlanGenerationInputSchema>;

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
}

export interface PlanGenerationResult {
  /** 与 Python 完全一致的 6 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/** 累计所有模型调用用量的 complete 包装，保证没有调用被漏记。 */
type UsageAwareComplete = (request: ModelCompletionRequest) => Promise<ModelCompletionResponse>;

function buildUserPrompt(input: PlanGenerationInput): string {
  return [
    '学习主题：' + input.goal.topic,
    '目标标题：' + input.goal.title,
    '目标描述：' + input.goal.description,
    '期望结果：' + input.goal.desired_outcome,
    '学习者水平：' + input.learner_profile.current_level,
    '每周可用分钟：' + String(input.learner_profile.weekly_minutes),
    '学习背景：' + (input.learner_profile.background_summary ?? ''),
    '前测得分：' + String(input.diagnostic_assessment.score_percent),
    '前测薄弱点摘要：' + JSON.stringify(input.diagnostic_assessment.mastery_summary ?? {}),
    '请生成一条 6-12 章的书籍章节式学习路线。',
  ].join('\n');
}

/** 追加「原文 assistant 消息 + 指令 system 消息」；Python 同时会清空 tools，本实现没有工具。 */
function withRecoveryMessages(
  request: ModelCompletionRequest,
  previousContent: string,
  instruction: string,
): ModelCompletionRequest {
  const messages: ModelMessage[] = [
    ...request.messages,
    { role: 'assistant', content: previousContent },
    { role: 'system', content: instruction },
  ];
  return { ...request, messages };
}

/** 尝试把一次模型输出解析为路线文档；失败返回 null（不记录模型正文）。 */
function tryParsePlan(content: string): LearningPlanDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch {
    return null;
  }
  const parsed = LearningPlanDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 首轮 + 两次修复；与 Python 的 _parse_or_repair 一致，返回 repair_attempts 取 0/1/2。 */
async function parseOrRepair(input: {
  complete: UsageAwareComplete;
  request: ModelCompletionRequest;
  content: string;
}): Promise<{ document: LearningPlanDocument | null; repairAttempts: number }> {
  let candidate = input.content;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parsed = tryParsePlan(candidate);
    if (parsed !== null) {
      return { document: parsed, repairAttempts: attempt };
    }
    if (attempt === 2) {
      return { document: null, repairAttempts: attempt };
    }
    const response = await input.complete(
      withRecoveryMessages(input.request, candidate, ROUTE_REPAIR_INSTRUCTION),
    );
    if ((response.message.toolCalls?.length ?? 0) > 0 || !response.message.content) {
      return { document: null, repairAttempts: attempt + 1 };
    }
    candidate = response.message.content;
  }
  throw new Error('路线修复循环不应在没有返回时结束。');
}

/** 兜底恢复结果的解析：先宽松规范化再严格校验，仍失败时做一次结构化修复。 */
async function parseRecoveryResponse(input: {
  complete: UsageAwareComplete;
  request: ModelCompletionRequest;
  content: string | null;
  hasToolCalls: boolean;
  errorCode: string;
  failureMessage: string;
}): Promise<LearningPlanDocument> {
  if (input.hasToolCalls || input.content === null) {
    throw new ModelGatewayError(
      input.errorCode,
      input.failureMessage + ' 校验路径: response.content_missing',
      false,
    );
  }

  let candidate = input.content;
  let validationPaths: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const normalized = normalizeRecoveryDocument(extractJsonText(candidate));
      const parsed = LearningPlanDocumentSchema.safeParse(normalized);
      if (parsed.success) {
        return parsed.data;
      }
      validationPaths = planValidationPaths(parsed.error);
    } catch (error) {
      validationPaths = error instanceof PlanRecoveryNormalizationError ? [error.path] : ['response.json'];
    }

    if (attempt === 1) {
      break;
    }
    const instruction =
      '上一轮路线恢复结果未通过校验，字段路径为：' + validationPaths.slice(0, 8).join(', ') + '。请只返回严格 JSON，'
      + '顶层只能有 schema_version、title、summary、nodes；每个 node 只能有 node_key、ordinal、title、node_brief、learning_objective、'
      + 'rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；禁止 description、topics、goal、dependencies 等旧字段；'
      + 'nodes 必须为 6-12 个章节、ordinal 连续、依赖存在且无环；不要输出解释文字。';
    const repaired = await input.complete(withRecoveryMessages(input.request, candidate, instruction));
    if ((repaired.message.toolCalls?.length ?? 0) > 0 || !repaired.message.content) {
      validationPaths = ['response.repair_content_missing'];
      break;
    }
    candidate = repaired.message.content;
  }

  const pathSummary = validationPaths.slice(0, 8).join(', ') || 'response.json';
  throw new ModelGatewayError(
    input.errorCode,
    input.failureMessage + ' 校验路径: ' + pathSummary,
    false,
  );
}

/** Tavily 不可用时的最后安全恢复：仅使用模型已有知识重建路线，仍须通过同一份合同。 */
async function rebuildWithoutSources(input: {
  complete: UsageAwareComplete;
  runId: string;
  value: PlanGenerationInput;
  connection: ModelProviderConnection;
  /** 联网工具返回的错误类别，原样回填到提示词中。 */
  tavilyErrorCode: string;
}): Promise<LearningPlanDocument> {
  const request: ModelCompletionRequest = {
    agentRunId: input.runId,
    connection: input.connection,
    messages: [
      { role: 'system', content: RECOVERY_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          '学习主题：' + input.value.goal.topic
          + '\n目标：' + input.value.goal.desired_outcome
          + '\nTavily 错误类别：' + input.tavilyErrorCode,
      },
    ],
    responseFormat: 'json_object',
  };
  const response = await input.complete(request);
  return parseRecoveryResponse({
    complete: input.complete,
    request,
    content: response.message.content ?? null,
    hasToolCalls: (response.message.toolCalls?.length ?? 0) > 0,
    errorCode: 'PLAN_MODEL_RECOVERY_INVALID',
    failureMessage: '无资料模型恢复结果仍不符合路线合同。',
  });
}

/**
 * 在最终校验失败后强制 Tavily 搜索、阅读并重建路线（对应 Python 的 _rebuild_with_tavily）。
 * 联网工具不可用时退回无资料重建，两条路径都必须通过同一份路线合同。
 */
async function rebuildWithTavily(input: {
  complete: UsageAwareComplete;
  toolGateway: ToolGatewayPort;
  runId: string;
  value: PlanGenerationInput;
  connection: ModelProviderConnection;
}): Promise<LearningPlanDocument> {
  const query = (
    input.value.goal.topic + ' 官方文档 教程 目录 ' + input.value.goal.desired_outcome
  ).slice(0, 500);
  const toolResult = await input.toolGateway.execute({
    id: 'forced_tavily_' + randomUUID().replace(/-/g, ''),
    name: TAVILY_SEARCH_TOOL.name,
    argumentsJson: JSON.stringify({ query }),
  });
  if (!toolResult.ok) {
    return rebuildWithoutSources({
      complete: input.complete,
      runId: input.runId,
      value: input.value,
      connection: input.connection,
      tavilyErrorCode: toolResult.code,
    });
  }

  const sourceContext = JSON.stringify(toolResult.data);
  const request: ModelCompletionRequest = {
    agentRunId: input.runId,
    connection: input.connection,
    messages: [
      {
        role: 'system',
        content:
          '你正在执行强制联网兜底。请仅基于以下 Tavily 搜索和资源阅读摘要，严格按 schema_version、title、summary、nodes 输出；'
          + '每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；'
          + '禁止 description、topics、goal、dependencies 等旧字段；路线必须有 6-12 个章节、ordinal 连续、依赖存在且无环。',
      },
      {
        role: 'user',
        content:
          '学习主题：' + input.value.goal.topic
          + '\n目标：' + input.value.goal.desired_outcome
          + '\n参考资料摘要：' + sourceContext,
      },
    ],
    responseFormat: 'json_object',
  };
  const response = await input.complete(request);
  return parseRecoveryResponse({
    complete: input.complete,
    request,
    content: response.message.content ?? null,
    hasToolCalls: (response.message.toolCalls?.length ?? 0) > 0,
    errorCode: 'PLAN_TAVILY_SOURCE_RECOVERY_INVALID',
    failureMessage: '基于 Tavily 资料的路线恢复结果仍不符合路线合同。',
  });
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
  const complete: UsageAwareComplete = async (request) => {
    const response = await deps.gateway.complete(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  };

  const request: ModelCompletionRequest = {
    agentRunId: input.runId,
    connection,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(value) },
    ],
    responseFormat: 'json_object',
  };

  // 与 Python 一致：首轮由模型自主决定是否调用 Tavily，工具循环在 tool-aware-generator 中。
  const initial = await runToolAwareGeneration({
    complete,
    toolGateway: deps.toolGateway,
    maxToolCalls: deps.maxToolCalls,
    request: { ...request, tools: [TAVILY_SEARCH_TOOL], toolChoice: 'auto' },
  });
  const toolCallCount = initial.toolCallCount;

  const parsed = await parseOrRepair({ complete, request, content: initial.content });
  let plan = parsed.document;
  const repairAttempts = parsed.repairAttempts;
  let generationPath = toolCallCount > 0 ? 'model_with_tavily' : 'model_knowledge';
  let fallbackUsed = false;

  if (plan === null) {
    fallbackUsed = true;
    generationPath = 'tavily_recovery';
    plan = await rebuildWithTavily({
      complete,
      toolGateway: deps.toolGateway,
      runId: input.runId,
      value,
      connection,
    });
  }

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
export type PlanGenerationWorkflowDeps = Omit<PlanGenerationDeps, 'toolGateway'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
};

export function createPlanGenerateWorkflow(deps: PlanGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runPlanGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        { ...deps, toolGateway: deps.createToolGateway(executionState.ownerId) },
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
