/**
 * OpenAI-compatible 模型网关（等价于 Python 的 OpenAiCompatibleModelGateway）。
 *
 * 职责：把业务请求转换为 Provider 载荷，经受控出网客户端以 SSE 调用，再把流式事件聚合为完整响应；
 * 同时保留 Python 侧的重试、错误分类与“工具场景请求被拒”的特殊映射。
 *
 * 与 Python 一致的行为：
 * - 固定 stream=true 且 stream_options.include_usage=true；
 * - 仅当 model_id 以 deepseek-v4- 开头时才带 thinking 参数；
 * - response_format=json_object 时确保提示词中出现小写 json；
 * - 只处理 choices[0]；tool_calls 按 index 合并参数字符串；finish_reason=length 视为截断（不可重试）；
 * - 可重试错误按 0.5 * 2^attempt 退避，最多 requestMaxRetries 次额外重试。
 *
 * 导出：
 * - ModelMessage / ModelToolCall / ModelToolDefinition / ModelProviderConnection
 * - ModelCompletionRequest / ModelCompletionResponse / ModelUsage
 * - ModelGatewayError（含 retryable 与 validationPaths）
 * - OpenAiCompatibleModelGateway：complete。
 */

import {
  ModelEgressRequestError,
  type ModelEgressCallInput,
} from './safe-egress-client.js';

/** 出网端口：网关只依赖它，测试可注入假实现。 */
export interface ModelEgressPort {
  postOpenAiCompatibleSse(
    input: ModelEgressCallInput,
  ): Promise<{ statusCode: number; events: AsyncIterable<unknown> }>;
}

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelMessage {
  role: ModelRole;
  content: string | null;
  reasoningContent?: string | null;
  toolCalls?: readonly ModelToolCall[];
  toolCallId?: string | null;
  name?: string | null;
}

export interface ModelProviderConnection {
  ownerId: string;
  connectionId: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelCompletionRequest {
  agentRunId: string;
  connection: ModelProviderConnection;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
  thinkingMode?: 'enabled';
  responseFormat?: 'text' | 'json_object';
  /**
   * 可选的思考增量回调：流式过程中按到达顺序回调 `delta.reasoning_content` 片段，
   * 用于「边生成边展示思考过程」。回调失败会被忽略，不影响本次调用与聚合结果。
   */
  onReasoningDelta?: (text: string) => void;
}

export interface ModelCompletionResponse {
  message: ModelMessage;
  usage: ModelUsage;
  finishReason: string | null;
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly validationPaths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

const TOOL_REJECTED_CODES = new Set([
  'MODEL_PROVIDER_HTTP_400',
  'MODEL_PROVIDER_HTTP_404',
  'MODEL_PROVIDER_HTTP_405',
  'MODEL_PROVIDER_HTTP_422',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProviderMessage(message: ModelMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { role: message.role };
  if (message.content !== null && message.content !== undefined) {
    payload.content = message.content;
  } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
    payload.content = '';
  }
  if (message.reasoningContent !== null && message.reasoningContent !== undefined) {
    payload.reasoning_content = message.reasoningContent;
  }
  if ((message.toolCalls?.length ?? 0) > 0) {
    payload.tool_calls = (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  if (message.role === 'tool') {
    payload.tool_call_id = message.toolCallId ?? null;
    payload.name = message.name ?? null;
  }
  return payload;
}

/** response_format=json_object 时确保首条 system/user 消息中出现小写 json。 */
function ensureJsonPrompt(messages: Record<string, unknown>[]): void {
  for (const message of messages) {
    const role = message.role;
    if ((role === 'system' || role === 'user') && typeof message.content === 'string') {
      if (!message.content.toLowerCase().includes('json')) {
        message.content = message.content + '\nReturn a valid json object.';
      }
      return;
    }
  }
  messages.unshift({ role: 'system', content: 'Return a valid json object.' });
}

export class OpenAiCompatibleModelGateway {
  constructor(
    private readonly egressClient: ModelEgressPort,
    private readonly requestMaxRetries: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** 发起一次（含重试）模型调用，返回聚合后的完整响应。 */
  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    const payload = this.buildPayload(request);
    const hasTools = (request.tools?.length ?? 0) > 0;
    let lastError: ModelGatewayError | null = null;

    for (let attempt = 0; attempt <= this.requestMaxRetries; attempt += 1) {
      try {
        const response = await this.egressClient.postOpenAiCompatibleSse({
          ownerId: request.connection.ownerId,
          modelConnectionId: request.connection.connectionId,
          agentRunId: request.agentRunId,
          baseUrl: request.connection.baseUrl,
          apiKey: request.connection.apiKey,
          endpointSegments: ['chat', 'completions'],
          payload,
        });
        const accumulator = new ModelCompletionAccumulator(request.onReasoningDelta);
        for await (const event of response.events) {
          accumulator.accept(event);
        }
        return accumulator.finish();
      } catch (error) {
        if (!(error instanceof ModelEgressRequestError)) {
          throw error;
        }
        const mapped = toGatewayError(error, hasTools);
        lastError = mapped;
        if (!mapped.retryable || attempt === this.requestMaxRetries) {
          throw mapped;
        }
        await this.sleep(500 * 2 ** attempt);
      }
    }

    throw lastError ?? new ModelGatewayError('MODEL_PROVIDER_RESPONSE_INVALID', '模型调用失败。', false);
  }

  /** 构造 Provider 请求载荷；字段与 Python 的 _build_payload 一一对应。 */
  buildPayload(request: ModelCompletionRequest): Record<string, unknown> {
    const messages = request.messages.map(toProviderMessage);
    if (request.responseFormat === 'json_object') {
      ensureJsonPrompt(messages);
    }

    const payload: Record<string, unknown> = {
      model: request.connection.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if ((request.tools?.length ?? 0) > 0) {
      payload.tools = (request.tools ?? []).map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      payload.tool_choice = request.toolChoice ?? 'auto';
    }

    // 仅 DeepSeek V4 系列接受该私有参数。
    if (request.connection.modelId.trim().toLowerCase().startsWith('deepseek-v4-')) {
      payload.thinking = { type: request.thinkingMode ?? 'enabled' };
    }

    if (request.responseFormat === 'json_object') {
      payload.response_format = { type: 'json_object' };
    }

    return payload;
  }
}

/** 把出网错误映射为网关错误；工具场景下的 4xx 请求拒绝单独归类。 */
function toGatewayError(error: ModelEgressRequestError, hasTools: boolean): ModelGatewayError {
  if (hasTools && TOOL_REJECTED_CODES.has(error.code)) {
    return new ModelGatewayError(
      'MODEL_TOOL_CALL_REQUEST_REJECTED',
      'Provider 拒绝了带工具的请求。',
      false,
    );
  }
  return new ModelGatewayError(error.code, error.message, error.retryable);
}

/**
 * OpenAI-compatible 流式聚合器：每收到一个事件立即合并，只保留工作流最终需要的正文、思考、
 * 工具参数、用量和结束原因，不保存 Provider 原始事件数组。
 */
export class ModelCompletionAccumulator {
  private content = '';
  private reasoningContent = '';
  private finishReason: string | null = null;
  private readonly toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private readonly onReasoningDelta?: (text: string) => void) {}

  /** 合并一个 Provider SSE 事件；只处理 choices[0]，工具调用按 index 拼接。 */
  accept(event: unknown): void {
    if (!isRecord(event)) {
      return;
    }
    const usage = event.usage;
    if (isRecord(usage)) {
      if (typeof usage.prompt_tokens === 'number') {
        this.inputTokens = usage.prompt_tokens;
      }
      if (typeof usage.completion_tokens === 'number') {
        this.outputTokens = usage.completion_tokens;
      }
    }

    const choices = event.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return;
    }
    const choice = choices[0];
    if (!isRecord(choice)) {
      return;
    }
    if (typeof choice.finish_reason === 'string') {
      this.finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!isRecord(delta)) {
      return;
    }
    if (typeof delta.content === 'string') {
      this.content += delta.content;
    }
    if (typeof delta.reasoning_content === 'string') {
      this.reasoningContent += delta.reasoning_content;
      if (delta.reasoning_content.length > 0 && this.onReasoningDelta !== undefined) {
        try {
          this.onReasoningDelta(delta.reasoning_content);
        } catch {
          // 思考进度展示是 best-effort；回调失败不能影响模型聚合与工作流执行。
        }
      }
    }
    const rawToolCalls = delta.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      rawToolCalls.forEach((rawCall, position) => {
        if (!isRecord(rawCall)) {
          return;
        }
        const index = typeof rawCall.index === 'number' && rawCall.index >= 0 ? rawCall.index : position;
        const existing = this.toolCalls.get(index) ?? { id: '', name: '', argumentsJson: '' };
        if (typeof rawCall.id === 'string' && rawCall.id.length > 0) {
          existing.id = rawCall.id;
        }
        const fn = rawCall.function;
        if (isRecord(fn)) {
          if (typeof fn.name === 'string' && fn.name.length > 0) {
            existing.name = fn.name;
          }
          if (typeof fn.arguments === 'string') {
            existing.argumentsJson += fn.arguments;
          }
        }
        this.toolCalls.set(index, existing);
      });
    }
  }

  /** 流结束后校验并生成工作流使用的完整响应。 */
  finish(): ModelCompletionResponse {
    if (this.finishReason === 'length') {
      throw new ModelGatewayError(
        'MODEL_PROVIDER_RESPONSE_TRUNCATED',
        '模型输出因长度上限被截断。',
        false,
      );
    }

    const mergedToolCalls = [...this.toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, call]) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson }));

    if (this.content.length === 0 && mergedToolCalls.length === 0) {
      throw new ModelGatewayError('MODEL_PROVIDER_RESPONSE_INVALID', '模型没有返回最终文本内容。', false);
    }

    return {
      message: {
        role: 'assistant',
        content: this.content,
        reasoningContent: this.reasoningContent.length > 0 ? this.reasoningContent : null,
        toolCalls: mergedToolCalls,
      },
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      finishReason: this.finishReason,
    };
  }
}

/** 兼容同步测试与局部调用：逐事件喂给同一个聚合器后返回完整响应。 */
export function parseStreamCompletion(events: Iterable<unknown>): ModelCompletionResponse {
  const accumulator = new ModelCompletionAccumulator();
  for (const event of events) {
    accumulator.accept(event);
  }
  return accumulator.finish();
}
