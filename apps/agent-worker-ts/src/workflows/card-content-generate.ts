/**
 * card_content_generate 节点教学内容生成工作流（等价于 Python 的 workflows/card_content_generate.py）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 生成节点知识文档（foundation / worked_example / pitfalls_debug / source_refs / teaching_memory）
 * → 规范化与一次结构化修复 → 兜底重建 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与 Python 逐项对齐的行为：
 * - 输入契约：agent_role 固定 node_tutor，logical_session_key 1-200，goal / learner_profile /
 *   learning_plan / plan_node 都是宽松对象（Python 为 dict[str, Any]）；
 * - 提示词：system 与 user 文案一致（联网相关一句改写为「不提供工具」，见下），
 *   完成标准按原字段顺序序列化后嵌入；
 * - 解析：每次都先经 card-content-document.ts 的宽松规范化再严格校验（与 Python from_json 相同）；
 * - 失败路径：首轮解析失败 → 一次无工具修复；修复仍失败 → 兜底重建（本实现直接走无资料分支）；
 * - 回写载荷与输出摘要字段与 Python 一致（4 个摘要键、3 个元数据键）。
 *
 * **已确认的行为差异：** token 用量写真实值，覆盖首轮、修复与兜底的全部模型调用。
 *
 * 联网工具（Tavily 远程 MCP）已接入：首轮由模型自主决定是否调用，工具调用数写入
 * generation_metadata；全部严格校验失败后先执行 _rebuild_with_tavily（强制联网检索后重建），
 * 联网不可用时再退回 _rebuild_without_sources。
 *
 * **与 Python 的差异：** plan_node.id 必填——Python 直接下标取值，缺失时是 KeyError；
 * 本实现在输入校验阶段返回 CARD_CONTENT_INPUT_INVALID。
 *
 * 导出：
 * - CardContentGenerationInputSchema / CardContentGenerationInput
 * - CardContentInternalPort / CardContentModelGatewayPort：工作流依赖的最小端口。
 * - CardContentGenerationDeps / CardContentGenerationResult。
 * - runCardContentGenerate：执行一次节点内容生成。
 * - createCardContentGenerateWorkflow：适配为注册表可用的 AgentWorkflow。
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
import type {
  DefaultModelConnectionEnvelope,
  PersistedCardContentEnvelope,
} from '../schemas/core-internal.js';
import {
  runToolAwareGeneration,
  type ToolGatewayPort,
} from '../application/services/tool-aware-generator.js';
import { TAVILY_SEARCH_TOOL } from '../infrastructure/mcp/tavily-tool-gateway.js';
import {
  CardContentParseError,
  parseCardContentDocument,
  type CardContentDocument,
} from './card-content-document.js';

/** 联网工具未配置或不可用时的占位错误类别；正常路径会回填工具返回的真实类别。 */
const TAVILY_UNAVAILABLE_CODE = 'TAVILY_TOOL_NOT_AVAILABLE';

const SYSTEM_PROMPT = [
  '你是 LearnCraft 的 Node Tutor。请生成可阅读的节点知识文档，最终只输出严格 JSON。',
  '所有面向学习者的文字使用简体中文，技术名词和代码可保留英文；内容要对于读者易懂，而不可以堆砌专业词汇，如要使用专业词汇需进行解释。',
  '使用金字塔原理向用户讲解内容，内容必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory，且 foundation 与 pitfalls_debug 必须是针对当前章节的具体内容，不能使用模板句、占位符或泛化建议。',
  'foundation 必须像教材章节一样解释本章核心概念、关键术语、概念之间的关系，以及学习者需要形成的判断方式；至少分成 3 个有实质信息的段落。',
  'pitfalls_debug 必须是对象数组，每项只能包含 title、cause、fix 三个字段；title 写误区，cause 写原因，fix 写修复方法。数量由章节复杂度决定，不设固定上限，但至少提供 1 项。',
  'worked_example 必须包含 explanation、code、call_sequence、expected_output；不包含本地运行命令、依赖安装、stdout 或伪造执行结果。',
  'teaching_memory 必须包含 key_concepts、common_mistakes、assessment_targets。',
  '稳定知识可直接生成；涉及近期 API、版本或不确定事实时可自主调用 tavily_search。',
].join('');

const REPAIR_INSTRUCTION =
  '上一轮节点内容不符合 card_content.v1。请只返回严格合法 JSON，补齐 foundation、worked_example、'
  + 'pitfalls_debug、source_refs、teaching_memory；pitfalls_debug 必须是至少 1 项的对象数组，'
  + '每项只能包含 title、cause、fix 三个非空字段；不要输出额外文字。';

const RECOVERY_SYSTEM_PROMPT =
  '联网资料不可用，请仅使用你已有的稳定知识生成节点内容。只输出严格 JSON，必须包含 foundation、'
  + 'worked_example、pitfalls_debug、source_refs、teaching_memory；pitfalls_debug 必须是至少 1 项的对象数组，'
  + '每项只能包含 title、cause、fix 三个非空字段，数量不设固定上限；worked_example 必须有 explanation、code、'
  + 'call_sequence、expected_output；source_refs 可以为空；不要输出额外文字。';

export const CardContentGenerationInputSchema = z
  .object({
    agent_role: z.literal('node_tutor'),
    logical_session_key: z.string().min(1).max(200),
    goal: z.record(z.string(), z.unknown()),
    learner_profile: z.record(z.string(), z.unknown()),
    learning_plan: z.record(z.string(), z.unknown()),
    plan_node: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    // Python 直接取 value.plan_node["id"]，缺失即 KeyError；这里提前判为输入非法。
    if (typeof value.plan_node.id !== 'string' || value.plan_node.id.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['plan_node', 'id'],
        message: 'plan_node.id 必须是非空字符串。',
      });
    }
  });

export type CardContentGenerationInput = z.infer<typeof CardContentGenerationInputSchema>;

/** 内部接口端口：工作流只依赖这两个方法。 */
export interface CardContentInternalPort {
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistCardContent(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedCardContentEnvelope>;
}

/** 模型网关端口：工作流只依赖 complete。 */
export interface CardContentModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface CardContentGenerationDeps {
  internalClient: CardContentInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: CardContentModelGatewayPort;
  /** 联网工具网关（Tavily）；未配置 Key 时返回受控错误而不是抛异常。 */
  toolGateway: ToolGatewayPort;
  /** 单次运行可见的工具调用上限。 */
  maxToolCalls: number;
}

export interface CardContentGenerationResult {
  /** 与 Python 完全一致的 4 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

type UsageAwareComplete = (request: ModelCompletionRequest) => Promise<ModelCompletionResponse>;

function buildUserPrompt(value: CardContentGenerationInput): string {
  const node = value.plan_node;
  const goal = value.goal;
  const profile = value.learner_profile;
  return [
    '学习主题：' + String(goal.topic ?? ''),
    '学习目标：' + String(goal.desired_outcome ?? ''),
    '学习者水平：' + String(profile.current_level ?? ''),
    '章节标题：' + String(node.title ?? ''),
    '章节摘要：' + String(node.node_brief ?? ''),
    '章节目标：' + String(node.learning_objective ?? ''),
    '完成标准：' + JSON.stringify(node.completion_criteria ?? []),
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

/** 一次无工具模型请求并解析节点内容；消息与 Python 的 _complete_document 一致。 */
async function completeDocument(input: {
  complete: UsageAwareComplete;
  request: ModelCompletionRequest;
}): Promise<CardContentDocument> {
  const response = await input.complete(input.request);
  if ((response.message.toolCalls?.length ?? 0) > 0 || !response.message.content) {
    throw new ModelGatewayError(
      'CARD_CONTENT_OUTPUT_INVALID',
      '模型没有返回可校验的节点内容。',
      false,
    );
  }
  try {
    return parseCardContentDocument(response.message.content);
  } catch (error) {
    if (!(error instanceof CardContentParseError)) {
      throw error;
    }
    throw new ModelGatewayError(
      'CARD_CONTENT_OUTPUT_INVALID',
      '模型返回的节点内容不符合 card_content.v1。',
      false,
    );
  }
}

/** 先校验首轮结果，失败时执行一次无工具结构化修复。 */
async function parseOrRepair(input: {
  complete: UsageAwareComplete;
  request: ModelCompletionRequest;
  content: string;
}): Promise<CardContentDocument> {
  try {
    return parseCardContentDocument(input.content);
  } catch (error) {
    if (!(error instanceof CardContentParseError)) {
      throw error;
    }
  }

  const repairRequest = withRecoveryMessages(input.request, input.content, REPAIR_INSTRUCTION);
  try {
    return await completeDocument({ complete: input.complete, request: repairRequest });
  } catch (error) {
    if (!(error instanceof ModelGatewayError)) {
      throw error;
    }
    throw new ModelGatewayError(
      'CARD_CONTENT_OUTPUT_INVALID',
      '节点知识内容经过修复后仍不符合内容合同。',
      false,
    );
  }
}

/** 联网资料不可用时使用模型稳定知识恢复，保持同一内容合同。 */
async function rebuildWithoutSources(input: {
  complete: UsageAwareComplete;
  runId: string;
  value: CardContentGenerationInput;
  connection: ModelProviderConnection;
  /** 联网工具返回的错误类别，原样回填到提示词中。 */
  tavilyError: string;
}): Promise<CardContentDocument> {
  const request: ModelCompletionRequest = {
    agentRunId: input.runId,
    connection: input.connection,
    messages: [
      { role: 'system', content: RECOVERY_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          '节点：' + String(input.value.plan_node.title ?? '')
          + '\n联网工具错误类别：' + input.tavilyError,
      },
    ],
    responseFormat: 'json_object',
  };
  try {
    return await completeDocument({ complete: input.complete, request });
  } catch (error) {
    if (!(error instanceof ModelGatewayError)) {
      throw error;
    }
    throw new ModelGatewayError(
      'CARD_CONTENT_MODEL_RECOVERY_INVALID',
      '无资料模型恢复结果仍不符合节点内容合同（联网错误类别：' + input.tavilyError + '）。',
      false,
    );
  }
}

/**
 * 最终校验失败时强制 Tavily 搜索，并要求模型基于资料重建内容（对应 Python 的 _rebuild_with_tavily）。
 * 联网工具不可用时退回无资料恢复，两条路径都保持同一内容合同。
 */
async function rebuildWithTavily(input: {
  complete: UsageAwareComplete;
  toolGateway: ToolGatewayPort;
  runId: string;
  value: CardContentGenerationInput;
  connection: ModelProviderConnection;
}): Promise<CardContentDocument> {
  const query = (
    String(input.value.goal.topic ?? '') + ' ' + String(input.value.plan_node.title ?? '') + ' 官方文档 教程'
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
      tavilyError: toolResult.code,
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
          '你正在执行节点知识内容的最终联网兜底。请只输出严格 JSON，必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory；'
          + 'pitfalls_debug 必须是至少 1 项的对象数组，每项只能包含 title、cause、fix 三个非空字段，数量不设固定上限；'
          + 'worked_example 必须有 explanation、code、call_sequence、expected_output；只能基于下方 Tavily 资料，不要输出额外文字。',
      },
      {
        role: 'user',
        content:
          '节点：' + String(input.value.plan_node.title ?? '')
          + '\nTavily 资料摘要：' + sourceContext,
      },
    ],
    responseFormat: 'json_object',
  };
  try {
    return await completeDocument({ complete: input.complete, request });
  } catch (error) {
    if (!(error instanceof ModelGatewayError)) {
      throw error;
    }
    throw new ModelGatewayError(
      'CARD_CONTENT_TAVILY_RECOVERY_INVALID',
      'Tavily 兜底生成的节点内容仍不符合内容合同。',
      false,
    );
  }
}

/** 执行一次节点内容生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runCardContentGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: CardContentGenerationDeps,
): Promise<CardContentGenerationResult> {
  const parsedInput = CardContentGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('CARD_CONTENT_INPUT_INVALID', '节点内容生成输入不符合契约。', false);
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

  let document: CardContentDocument;
  try {
    document = await parseOrRepair({ complete, request, content: initial.content });
  } catch (error) {
    if (!(error instanceof ModelGatewayError)) {
      throw error;
    }
    document = await rebuildWithTavily({
      complete,
      toolGateway: deps.toolGateway,
      runId: input.runId,
      value,
      connection,
    });
  }

  const planNodeId = String(value.plan_node.id);
  const persisted = await deps.internalClient.persistCardContent(input.runId, {
    ...document,
    plan_node_id: planNodeId,
    generation_metadata: {
      model_id: connection.modelId,
      tool_call_count: toolCallCount,
      logical_session_key: value.logical_session_key,
    },
  });

  return {
    outputSummary: {
      card_content_id: persisted.card_content_id,
      plan_node_id: planNodeId,
      tool_call_count: toolCallCount,
      model_id: connection.modelId,
    },
    usage,
  };
}

/**
 * 把节点内容工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type CardContentGenerationWorkflowDeps = Omit<CardContentGenerationDeps, 'toolGateway'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
};

export function createCardContentGenerateWorkflow(deps: CardContentGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runCardContentGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        { ...deps, toolGateway: deps.createToolGateway(executionState.ownerId) },
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
