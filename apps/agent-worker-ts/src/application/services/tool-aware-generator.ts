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

export const TOOL_CALL_LIMIT_REACHED = 'TOOL_CALL_LIMIT_REACHED';

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
 * 执行一次单会话 ReAct 循环：工具调用、校验失败与自纠都发生在同一个消息列表里。
 * 只有「轮数耗尽」这一种情况会抛错；工具失败不抛错，而是作为 tool 消息回传模型。
 */
export async function runReactAgentSession<T>(
  input: ReactSessionInput<T>,
): Promise<ReactSessionResult<T>> {
  let messages: ModelMessage[] = [...input.request.messages];
  let toolCallCount = 0;
  let validationFailures = 0;
  let lastPaths: string[] = ['response.json'];

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    const toolsAvailable = toolCallCount < input.maxToolCalls;
    const response = await input.complete({
      ...input.request,
      messages,
      ...(toolsAvailable
        ? { tools: [TAVILY_SEARCH_TOOL], toolChoice: 'auto' as const }
        : { tools: [], toolChoice: 'none' as const }),
    });
    const assistantMessage = response.message;

    // 工具调用轮：执行工具并把结果回传同一会话，让模型自己决定下一步。
    if ((assistantMessage.toolCalls?.length ?? 0) > 0) {
      messages = [...messages, assistantMessage];
      const remainingCalls = input.maxToolCalls - toolCallCount;
      const toolMessages: ModelMessage[] = [];

      for (const [index, toolCall] of (assistantMessage.toolCalls ?? []).entries()) {
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
}
