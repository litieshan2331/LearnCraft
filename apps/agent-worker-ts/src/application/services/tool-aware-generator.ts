/**
 * ReAct 会话循环（由原「工具感知生成循环」演进而来）。
 *
 * 职责：为一次 AgentRun 维护**唯一一个持续累积的会话**，在模型与工具网关之间循环：
 * - 模型要求工具时执行工具，工具成功或失败的结果都编码成 tool 消息回传同一会话，让模型自己判断下一步；
 * - 模型给出正文时交给调用方的 parse 做严格校验；校验失败不重建消息列表，而是把脱敏的字段路径
 *   作为一条 user 观察消息追加到**同一会话**，让模型在同一人格与同一上下文里自纠；
 * - 达到可见工具调用上限后不再提供工具，强制模型基于已有资料作答；
 * - 达到本工作流的 ReAct 轮数上限仍未通过校验时，抛调用方给定的错误码（不可重试）。
 *
 * 轮数语义：maxTurns 是**一次运行内允许的模型调用次数**（含只产生工具调用的轮次），
 * 因此它同时是成本上限；每个工作流通过 deps.reactMaxTurns 注入自己的取值。
 *
 * 实时进度：可选 onProgress 会在「每轮开始 / 思考增量 / 轮次思考结束 / 工具调用 / 工具返回 / 校验失败 /
 * 会话失败」上报事件；其中「思考增量」与「轮次思考结束」携带模型思考原文（本契约中唯一允许携带模型原文的
 * 两类事件，前者合并后流式下发、后者为权威整段），其余只含步骤与工具元数据
 * （见 application/services/agent-progress.ts）。思考原文的上报（实时透传 + 轮次权威整段）
 * 由 application/services/agent-thinking-stream.ts 负责，本文件不做缓冲也不做节流。
 * 未装配时使用空实现，上报本身绝不影响会话执行。
 *
 * 与 Python 的差异：Python 的 ToolAwareGenerator 自己累计并返回 usage；本实现要求调用方传入
 * 已经记账的 complete（各工作流用它统一累计真实 token 用量），这里只返回结果与计数。
 * 最终 JSON 不使用 response_format 约束，而是靠工作流提示词 + extractJsonText 解析。
 *
 * 导出：
 * - TOOL_CALL_LIMIT_REACHED：超出工具调用上限时回传给模型的稳定错误码。
 * - ToolGatewayPort：工具网关端口（Tavily 网关或测试替身）。
 * - serializeToolResult：按 Python 字段顺序序列化工具结果。
 * - ReactSessionInput / ReactSessionResult：一次 ReAct 会话的入参与结果。
 * - runReactAgentSession：执行一次单会话 ReAct 循环。
 */

import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
  type ModelToolCall,
} from '../../infrastructure/llm/model-gateway.js';
import {
  TAVILY_SEARCH_TOOL,
  type ToolExecutionResult,
} from '../../infrastructure/mcp/tavily-tool-gateway.js';
import {
  createNoopAgentProgressReporter,
  type AgentProgressReporter,
} from './agent-progress.js';
import { createAgentThinkingStream } from './agent-thinking-stream.js';
import type { TraceWriter } from './trace-writer.js';

export const TOOL_CALL_LIMIT_REACHED = 'TOOL_CALL_LIMIT_REACHED';

/** 工具调用参数里可上报的检索词最大长度（只上报摘要，不上报完整参数）。 */
const PROGRESS_QUERY_MAX_LENGTH = 120;



/** 工具网关端口：只依赖 execute。 */
export interface ToolGatewayPort {
  execute(toolCall: ModelToolCall): Promise<ToolExecutionResult>;
}

/** 会话内一次校验的结果：通过时给出值，失败时只给出脱敏的字段路径。 */
export interface ReactSessionParseResult<T> {
  value: T | null;
  paths: string[];
}

export interface ReactSessionInput<T> {
  /** 已记账的 complete：工作流用它累计 token 用量。 */
  complete: (request: ModelCompletionRequest) => Promise<ModelCompletionResponse>;
  toolGateway: ToolGatewayPort;
  /** 本工作流的 ReAct 轮数上限（一次运行内允许的模型调用次数，含工具调用轮）。 */
  maxTurns: number;
  /** 单次运行可见的工具调用上限。 */
  maxToolCalls: number;
  /** 初始会话：通常是 [system 人格, user 任务]；不设置 responseFormat。 */
  request: ModelCompletionRequest;
  /** 解析并严格校验最终 JSON；失败时返回字段路径，绝不记录模型正文。 */
  parse: (content: string) => ReactSessionParseResult<T>;
  /** 校验失败时追加到同一会话的观察文本（以 user 角色回灌）。 */
  buildFeedback: (context: { turn: number; paths: readonly string[] }) => string;
  /** 轮数耗尽时抛出的错误码与消息前缀。 */
  exhaustedErrorCode: string;
  exhaustedMessage: string;
  /** 可选的实时进度上报端口；缺省为空实现。 */
  onProgress?: AgentProgressReporter;
  /** 完整轨迹写入端口；记录模型完成与 Tool 原始输入输出。 */
  traceWriter?: TraceWriter;
}

export interface ReactSessionResult<T> {
  value: T;
  /** 本次会话累计的可见工具调用数。 */
  toolCallCount: number;
  /** 实际消耗的模型轮数，从 1 开始（1 表示首轮即通过）。 */
  turns: number;
  /** 首次通过校验前累计的校验失败次数（0 表示首轮即通过）。 */
  validationFailures: number;
}

/** 工具结果按 Python 的字段顺序序列化为 tool 消息内容。 */
export function serializeToolResult(result: ToolExecutionResult): string {
  return JSON.stringify({
    ok: result.ok,
    code: result.code,
    message: result.message,
    data: result.data,
  });
}

/**
 * 从工具调用参数里取出可展示的检索词摘要。
 * 只上报 query 字段本身（不含完整参数、不含工具返回内容），解析失败时返回 null。
 */
function toolQuerySummary(toolCall: ModelToolCall): string | null {
  try {
    const parsed: unknown = JSON.parse(toolCall.argumentsJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const query = (parsed as Record<string, unknown>).query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      return null;
    }
    return query.trim().slice(0, PROGRESS_QUERY_MAX_LENGTH);
  } catch {
    return null;
  }
}

/** 工具返回里可上报的来源条数；结构不符时返回 null。 */
function toolSourceCount(result: ToolExecutionResult): number | null {
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const sources = (data as Record<string, unknown>).sources;
  return Array.isArray(sources) ? sources.length : null;
}

/**
 * 执行一次单会话 ReAct 循环：工具调用、校验失败与自纠都发生在同一个消息列表里。
 * 只有「轮数耗尽」这一种情况会抛错；工具失败不抛错，而是作为 tool 消息回传模型。
 */
export async function runReactAgentSession<T>(
  input: ReactSessionInput<T>,
): Promise<ReactSessionResult<T>> {
  const progress: AgentProgressReporter = input.onProgress ?? createNoopAgentProgressReporter();
  let messages: ModelMessage[] = [...input.request.messages];
  let toolCallCount = 0;
  let validationFailures = 0;
  let lastPaths: string[] = ['response.json'];

  // 思考原文实时透传（不缓冲、不节流）；轮次权威整段也由它上报。
  const thinking = createAgentThinkingStream(progress);

  try {
    for (let turn = 1; turn <= input.maxTurns; turn += 1) {
      const toolsAvailable = toolCallCount < input.maxToolCalls;
      progress.report('turn.started', { turn, max_turns: input.maxTurns });
      const modelStartedAt = new Date();
      const response = await input.complete({
        ...input.request,
        messages,
        ...(toolsAvailable
          ? { tools: [TAVILY_SEARCH_TOOL], toolChoice: 'auto' as const }
          : { tools: [], toolChoice: 'none' as const }),
        // 流式思考增量：到达即透传，让前端实时显示。
        onReasoningDelta: (text: string) => {
          thinking.push(turn, text);
        },
      });

      await input.traceWriter?.append({
        runId: input.request.agentRunId,
        eventType: 'llm.attempt.completed',
        turnNo: turn,
        attemptNo: turn,
        startedAt: modelStartedAt,
        finishedAt: new Date(),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        payload: {
          request: {
            messages,
            tools: toolsAvailable ? [TAVILY_SEARCH_TOOL] : [],
            toolChoice: toolsAvailable ? 'auto' : 'none',
            thinkingMode: input.request.thinkingMode ?? null,
            responseFormat: input.request.responseFormat ?? 'text',
            provider: input.request.connection.baseUrl,
            model: input.request.connection.modelId,
          },
          output: response.message,
          finishReason: response.finishReason,
        },
      });

      const assistantMessage = response.message;
      // 该轮完整思考原文（网关已在流式聚合时收集）：作为权威整段下发，前端用它覆盖本轮增量。
      thinking.completeTurn(turn, assistantMessage.reasoningContent);

      // 工具调用轮：执行工具并把结果回传同一会话，让模型自己决定下一步。
      if ((assistantMessage.toolCalls?.length ?? 0) > 0) {
        messages = [...messages, assistantMessage];
        const remainingCalls = input.maxToolCalls - toolCallCount;
        const toolMessages: ModelMessage[] = [];
        // 批次基数在循环前取快照：toolCallCount 会在本批次内逐次 +1，
        // 若与批内下标相加会导致同一批次里第二个调用起编号跳号（1、3、5…）。
        const baseIndex = toolCallCount;

        for (const [index, toolCall] of (assistantMessage.toolCalls ?? []).entries()) {
          const callIndex = baseIndex + index + 1;
          const query = toolQuerySummary(toolCall);
          progress.report('tool.called', {
            turn,
            call_index: callIndex,
            tool: toolCall.name,
            ...(query === null ? {} : { query }),
          });

          const toolStartedAt = new Date();
          await input.traceWriter?.append({
            runId: input.request.agentRunId,
            eventType: 'tool.started',
            turnNo: turn,
            stepNo: turn,
            payload: {
              callId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
            },
            startedAt: toolStartedAt,
          });

          let result: ToolExecutionResult;
          if (index >= remainingCalls) {
            result = {
              ok: false,
              code: TOOL_CALL_LIMIT_REACHED,
              message: '本次任务已达到联网工具调用上限，请基于已有资料继续完成回答。',
              data: {},
            };
          } else {
            result = await input.toolGateway.execute(toolCall);
            toolCallCount += 1;
          }

          const sourceCount = toolSourceCount(result);
          await input.traceWriter?.append({
            runId: input.request.agentRunId,
            eventType: 'tool.completed',
            turnNo: turn,
            stepNo: turn,
            startedAt: toolStartedAt,
            finishedAt: new Date(),
            payload: {
              callId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
              result,
            },
          });
          progress.report('tool.completed', {
            turn,
            call_index: callIndex,
            tool: toolCall.name,
            ok: result.ok,
            code: result.code,
            ...(sourceCount === null ? {} : { source_count: sourceCount }),
          });

          toolMessages.push({
            role: 'tool',
            content: serializeToolResult(result),
            toolCallId: toolCall.id,
            name: toolCall.name,
          });
        }

        messages = [...messages, ...toolMessages];
        continue;
      }

      // 没有正文也没有工具调用：按一次校验失败处理，给模型一次重新作答的机会。
      if (!assistantMessage.content) {
        validationFailures += 1;
        lastPaths = ['response.content_missing'];
        progress.report('validation.failed', { turn, paths: lastPaths.join(',') });
        progress.report('turn.self_correcting', { turn, next_turn: turn + 1 });
        messages = [
          ...messages,
          { role: 'user', content: input.buildFeedback({ turn, paths: lastPaths }) },
        ];
        continue;
      }

      const parsed = input.parse(assistantMessage.content);
      if (parsed.value !== null) {
        return { value: parsed.value, toolCallCount, turns: turn, validationFailures };
      }

      validationFailures += 1;
      lastPaths = parsed.paths.length > 0 ? parsed.paths : ['response.json'];
      progress.report('validation.failed', { turn, paths: lastPaths.slice(0, 8).join(',') });
      progress.report('turn.self_correcting', { turn, next_turn: turn + 1 });
      messages = [
        ...messages,
        assistantMessage,
        { role: 'user', content: input.buildFeedback({ turn, paths: lastPaths }) },
      ];
    }

    const finalPaths = lastPaths.slice(0, 8);
    throw new ModelGatewayError(
      input.exhaustedErrorCode,
      input.exhaustedMessage + ' 校验路径: ' + finalPaths.join(', '),
      false,
      finalPaths,
    );
  } catch (error) {
    progress.report('run.failed', {
      code: error instanceof ModelGatewayError ? error.code : 'UNEXPECTED_ERROR',
      retryable: error instanceof ModelGatewayError ? error.retryable : false,
      validation_failures: validationFailures,
      tool_call_count: toolCallCount,
    });
    throw error;
  }
}
