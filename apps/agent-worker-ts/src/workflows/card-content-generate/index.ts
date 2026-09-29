/**
 * card_content_generate 节点教学内容生成工作流（单一 persona 的 ReAct 会话）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 在**唯一一个会话**里由模型生成节点知识文档（可自由调用 tavily_search 获取资料）→
 * 校验失败时由 ReAct 循环把字段路径回灌同一会话让模型自纠 → 经内部接口幂等持久化 → 返回摘要与用量。
 *
 * 与改造前（首轮 + 一次修复 + 强制联网兜底重建）的差异：
 * - 全程只有一个人格（prompts/SYSTEM_PROMPT），不再按阶段重建消息列表、不再强制 Tavily 检索与断网降级人格；
 * - 联网工具由模型在会话内自主决定是否调用（非强制）；
 * - 轮数上限由 deps.reactMaxTurns 注入（默认 5，环境变量 AGENT_REACT_MAX_TURNS_CARD_CONTENT）；
 * - 每次解析都先经 schema/ 的宽松规范化再严格校验（与 Python CardContentDocument.from_json 一致），
 *   校验失败时把 zod 字段路径回灌给模型。
 *
 * 行为保持不变的契约：
 * - 输入契约（agent_role 固定 node_tutor、plan_node.id 必填）、内容合同 card_content.v2
 *   （worked_example.files[] 逐文件拆分代码，expected_output 仍为单个字符串）、
 *   输出摘要的 4 个键与元数据的 3 个键不变；
 * - 结构类失败仍映射为 CARD_CONTENT_OUTPUT_INVALID；
 * - token 用量仍写真实值，由调用方写入 agent_runs 的 token 列。
 *
 * 本目录文件划分：schema/ 输入与内容合同、prompts/ 提示词；工作流主体（会话编排）在本文件。
 *
 * 导出：
 * - CardContentGenerationInputSchema / CardContentGenerationInput（转出 schema/）
 * - CardContentInternalPort / CardContentModelGatewayPort：工作流依赖的最小端口。
 * - CardContentGenerationDeps / CardContentGenerationResult。
 * - runCardContentGenerate：执行一次节点内容生成。
 * - CardContentGenerationWorkflowDeps / createCardContentGenerateWorkflow。
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
  type ModelProviderConnection,
} from '../../infrastructure/llm/model-gateway.js';
import type {
  DefaultModelConnectionEnvelope,
  PersistedCardContentEnvelope,
} from '../../schemas/core-internal.js';
import { buildUserPrompt, buildValidationFeedback, SYSTEM_PROMPT } from './prompts/index.js';
import {
  CardContentGenerationInputSchema,
  CardContentParseError,
  parseCardContentDocument,
  type CardContentDocument,
} from './schema/index.js';
export * from './schema/index.js';
import type { TraceWriter } from '../../application/services/trace-writer.js';

/** 会话内解析：宽松规范化 + 严格校验；失败时返回 zod 字段路径供模型自纠。 */
function parseCardContent(content: string): { value: CardContentDocument | null; paths: string[] } {
  try {
    return { value: parseCardContentDocument(content), paths: [] };
  } catch (error) {
    if (error instanceof CardContentParseError) {
      const paths = error.validationPaths.length > 0 ? [...error.validationPaths] : ['response.json'];
      return { value: null, paths };
    }
    throw error;
  }
}

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
  /** 本工作流的 ReAct 轮数上限（一次运行内允许的模型调用次数，含工具调用轮）。 */
  reactMaxTurns: number;
  /** 可选的实时进度上报端口（生成过程中的步骤/工具事件，不落库、不含模型原文）。 */
  progress?: AgentProgressReporter;
  /** 完整模型与工具观测写入端口。 */
  traceWriter?: TraceWriter;
}

export interface CardContentGenerationResult {
  /** 与 Python 完全一致的 4 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
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
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(value) },
  ];

  const outcome = await runReactAgentSession({
    complete,
    toolGateway: deps.toolGateway,
    maxTurns: deps.reactMaxTurns,
    maxToolCalls: deps.maxToolCalls,
    request: { agentRunId: input.runId, connection, messages },
    parse: parseCardContent,
    buildFeedback: (context) => buildValidationFeedback(context),
    exhaustedErrorCode: 'CARD_CONTENT_OUTPUT_INVALID',
    exhaustedMessage: '节点知识内容经过 ReAct 自纠后仍不符合内容合同。',
    onProgress: progress,
    traceWriter: deps.traceWriter,
  });

  const document = outcome.value;
  const planNodeId = String(value.plan_node.id);
  progress.report('result.persisting');
  const persisted = await deps.internalClient.persistCardContent(input.runId, {
    ...document,
    plan_node_id: planNodeId,
    generation_metadata: {
      model_id: connection.modelId,
      tool_call_count: outcome.toolCallCount,
      logical_session_key: value.logical_session_key,
    },
  });

  progress.report('run.completed', {
    tool_call_count: outcome.toolCallCount,
  });

  return {
    outputSummary: {
      card_content_id: persisted.card_content_id,
      plan_node_id: planNodeId,
      tool_call_count: outcome.toolCallCount,
      model_id: connection.modelId,
    },
    usage,
  };
}

/**
 * 把节点内容工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type CardContentGenerationWorkflowDeps = Omit<CardContentGenerationDeps, 'toolGateway' | 'progress'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
  /** 为一次运行创建进度上报器；缺省时使用空实现（不启用实时进度）。 */
  createProgressReporter?: (runId: string) => AgentProgressReporter;
};

export function createCardContentGenerateWorkflow(deps: CardContentGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runCardContentGenerate(
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
