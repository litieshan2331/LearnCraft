/**
 * 工具感知生成循环（等价于 Python 的 application/services/tool_aware_generator.py）。
 *
 * 职责：在模型与工具网关之间循环——模型要求工具时执行工具并把结果作为 tool 消息回传，
 * 直到模型给出最终文本；达到工具调用上限后停止提供工具，强制模型基于已有资料作答。
 * 工具失败不会中断流程，而是编码成 tool 消息交给模型，与 Python 的「工具失败不隐藏」一致。
 *
 * 与 Python 的差异：Python 的 ToolAwareGenerator 自己累计并返回 usage；本实现要求调用方传入
 * 已经记账的 complete（各工作流用它统一累计真实 token 用量），因此这里只返回正文与工具调用数。
 *
 * 导出：
 * - TOOL_CALL_LIMIT_REACHED：超出上限时回传给模型的稳定错误码。
 * - ToolGatewayPort：工具网关端口（Tavily 网关或测试替身）。
 * - ToolAwareGenerationInput / ToolAwareGenerationResult。
 * - runToolAwareGeneration：执行一次带工具的生成循环。
 */

import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
  type ModelToolCall,
} from '../../infrastructure/llm/model-gateway.js';
import type { ToolExecutionResult } from '../../infrastructure/mcp/tavily-tool-gateway.js';

export const TOOL_CALL_LIMIT_REACHED = 'TOOL_CALL_LIMIT_REACHED';

/** 工具网关端口：只依赖 execute。 */
export interface ToolGatewayPort {
  execute(toolCall: ModelToolCall): Promise<ToolExecutionResult>;
}

export interface ToolAwareGenerationInput {
  /** 已记账的 complete：工作流用它累计 token 用量。 */
  complete: (request: ModelCompletionRequest) => Promise<ModelCompletionResponse>;
  toolGateway: ToolGatewayPort;
  maxToolCalls: number;
  request: ModelCompletionRequest;
}

export interface ToolAwareGenerationResult {
  content: string;
  toolCallCount: number;
}

/** 工具结果按 Python 的字段顺序序列化为 tool 消息内容。 */
function serializeToolResult(result: ToolExecutionResult): string {
  return JSON.stringify({
    ok: result.ok,
    code: result.code,
    message: result.message,
    data: result.data,
  });
}

/** 执行模型与工具循环，直到模型给出最终文本。 */
export async function runToolAwareGeneration(
  input: ToolAwareGenerationInput,
): Promise<ToolAwareGenerationResult> {
  let messages: ModelMessage[] = [...input.request.messages];
  let toolCallCount = 0;
  let currentRequest: ModelCompletionRequest = input.request;

  for (;;) {
    const response = await input.complete({ ...currentRequest, messages });
    const assistantMessage = response.message;

    if ((assistantMessage.toolCalls?.length ?? 0) === 0) {
      if (!assistantMessage.content) {
        throw new ModelGatewayError(
          'MODEL_PROVIDER_RESPONSE_INVALID',
          '模型没有返回最终文本内容。',
          false,
        );
      }
      return { content: assistantMessage.content, toolCallCount };
    }

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
    currentRequest =
      toolCallCount >= input.maxToolCalls
        ? { ...input.request, tools: [], toolChoice: 'none' }
        : { ...input.request, toolChoice: 'auto' };
  }
}
