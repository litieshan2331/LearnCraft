/**
 * 学习助手 LangChain ChatModel 适配器。
 * 调用顺序：LangChain Agent 绑定工具 → 转换 BaseMessage/工具定义 → 调用现有 ModelPort → 转换为 AIMessage。
 * 适配器不创建 Provider 连接，模型重试、预算、限流和轨迹仍由注入的 ModelPort 负责。
 */
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatResult } from '@langchain/core/outputs';
import type { ModelMessage, ModelToolDefinition, ModelCompletionRequest, ModelCompletionResponse } from '../../../infrastructure/llm/model-gateway.js';
import type { ModelPort } from '../ports.js';

type AdapterRequest = Omit<ModelCompletionRequest, 'messages' | 'tools' | 'responseFormat' | 'toolChoice'>;

/** 把 LangChain 消息正文稳定转换为 Provider 可接受的文本。 */
function messageContent(message: BaseMessage): string | null {
  if (typeof message.content === 'string') return message.content;
  return message.content.length === 0 ? '' : JSON.stringify(message.content);
}

/** 将 LangChain 消息转换为项目网关使用的最小消息合同。 */
/** 将 LangChain 消息转换为项目网关使用的最小消息合同。 */
export function toModelMessage(message: BaseMessage): ModelMessage {
  if (message instanceof SystemMessage) return { role: 'system', content: messageContent(message) };
  if (message instanceof HumanMessage) return { role: 'user', content: messageContent(message) };
  if (message instanceof ToolMessage) {
    return { role: 'tool', content: messageContent(message), toolCallId: message.tool_call_id, name: message.name ?? null };
  }
  const toolCalls = (message as AIMessage).tool_calls ?? [];
  return {
    role: 'assistant',
    content: messageContent(message),
    ...(toolCalls.length === 0 ? {} : {
      toolCalls: toolCalls.map((call) => ({ id: call.id ?? '', name: call.name, argumentsJson: JSON.stringify(call.args) })),
    }),
  };
}

/** 将项目网关返回的助手消息转换为 LangChain AIMessage。 */
function toAIMessage(message: ModelMessage, usage?: ModelCompletionResponse['usage'], finishReason?: string | null): AIMessage {
  return new AIMessage({
    content: message.content ?? '',
    ...(usage === undefined ? {} : { usage_metadata: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } }),
    ...(finishReason === undefined ? {} : { response_metadata: { finish_reason: finishReason } }),
    ...(message.toolCalls === undefined ? {} : {
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, args: parseToolArguments(call.argumentsJson) })),
    }),
  });
}

/** 工具参数异常时保留原始字符串，让 Provider/上层错误路径可以观察到问题。 */
function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 把 LangChain 工具或 OpenAI 风格工具定义转换成网关合同。 */
function toToolDefinition(input: BindToolsInput): ModelToolDefinition {
  if (typeof input === 'object' && input !== null && 'function' in input) {
    const value = input as { function: { name: string; description?: string; parameters?: Record<string, unknown> } };
    return { name: value.function.name, description: value.function.description ?? '', parameters: value.function.parameters ?? { type: 'object', properties: {} } };
  }
  const value = input as { name?: string; description?: string; schema?: unknown };
  if (typeof value.name !== 'string' || value.name.length === 0) throw new Error('LangChain 工具缺少稳定名称');
  return {
    name: value.name,
    description: value.description ?? '',
    parameters: value.schema === undefined ? { type: 'object', properties: {} } : toJsonSchema(value.schema as never),
  };
}

/** 复用现有 ModelPort 的 LangChain ChatModel；不直接接触 Provider 或密钥。 */
export class LearningAssistantChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly boundTools: readonly ModelToolDefinition[];

  constructor(
    private readonly port: ModelPort,
    private readonly request: AdapterRequest,
    tools: readonly ModelToolDefinition[] = [],
  ) {
    super({});
    this.boundTools = tools;
  }

  /** LangChain 模型类型标识，用于运行时诊断。 */
  override _llmType(): string { return 'learncraft-openai-compatible'; }

  /** LangChain 模型家族标识。 */
  override _modelType(): string { return 'chat'; }

  /** 仅暴露非敏感模型标识，不序列化连接密钥。 */
  override _identifyingParams(): Record<string, unknown> { return { model: this.request.connection.modelId, tools: this.boundTools.map((tool) => tool.name) }; }

  /** 绑定工具定义，实际工具执行仍由 LangGraph ToolNode 完成。 */
  override bindTools(tools: BindToolsInput[]): LearningAssistantChatModel {
    return new LearningAssistantChatModel(this.port, this.request, tools.map(toToolDefinition));
  }

  /** 调用现有网关并保留用量结果。 */
  override async _generate(messages: BaseMessage[], _options: BaseChatModelCallOptions, runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    const response: ModelCompletionResponse = await this.port.complete({
      ...this.request,
      messages: messages.map(toModelMessage),
      tools: this.boundTools.length === 0 ? undefined : this.boundTools,
      responseFormat: 'text',
      onReasoningDelta: async (text) => { await runManager?.handleLLMNewToken(text); },
    });
    if (response.message.toolCalls?.some((call) => typeof call.id !== 'string' || call.id.trim().length === 0)) {
      throw new Error('模型工具调用缺少 tool_call_id');
    }
    return {
      generations: [{ text: response.message.content ?? '', message: toAIMessage(response.message, response.usage, response.finishReason) }],
      llmOutput: { tokenUsage: response.usage, finishReason: response.finishReason },
    };
  }
}

