/**
 * Worker 访问 Web 私有内部接口的反腐层（等价于 Python 的 WebCoreInternalClient）。
 *
 * 职责：以共享服务密钥调用 5 个内部端点，并把结果校验为受信任类型。
 * 错误分类与 Python 完全一致：网络异常与 5xx 可重试；404/401/403/契约不符与其余非 2xx 不可重试；
 * 未配置服务密钥时在发请求之前就失败。
 *
 * 导出：
 * - CoreInternalClientError：带稳定错误码与 retryable 的异常。
 * - CoreInternalClientOptions：baseUrl、internalServiceSecret、fetchImpl（测试注入）。
 * - CoreInternalClient：getDefaultModelConnection / getCardContentContext /
 *   persistAssessment / persistLearningPlan / persistCardContent。
 */

import {
  CardContentContextEnvelopeSchema,
  DefaultModelConnectionEnvelopeSchema,
  PersistedAssessmentEnvelopeSchema,
  PersistedCardContentEnvelopeSchema,
  PersistedLearningPlanEnvelopeSchema,
  type CardContentContextEnvelope,
  type DefaultModelConnectionEnvelope,
  type PersistedAssessmentEnvelope,
  type PersistedCardContentEnvelope,
  type PersistedLearningPlanEnvelope,
} from '../schemas/core-internal.js';

export const INTERNAL_SERVICE_SECRET_MISSING = 'INTERNAL_SERVICE_SECRET_MISSING';
export const INTERNAL_SERVICE_SECRET_HEADER = 'x-learncraft-internal-secret';

export class CoreInternalClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CoreInternalClientError';
  }
}

export interface CoreInternalClientOptions {
  baseUrl: string;
  internalServiceSecret: string | null;
  /** 测试注入用；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class CoreInternalClient {
  private readonly baseUrl: string;
  private readonly secret: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CoreInternalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.secret = options.internalServiceSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 读取任务所有者的 active 默认模型连接；响应中只包含 API Key 密文。 */
  async getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope> {
    return this.request({
      method: 'GET',
      path: '/agent-runs/' + agentRunId + '/default-model-connection',
      timeoutMs: 10_000,
      notFoundCode: 'DEFAULT_MODEL_CONNECTION_NOT_FOUND',
      notFoundMessage: '当前账户没有可用的默认模型连接。',
      rejectedCode: 'CORE_INTERNAL_RESPONSE_INVALID',
      rejectedMessage: 'Web 内部服务返回了不受支持的响应。',
      schema: DefaultModelConnectionEnvelopeSchema,
      invalidMessage: 'Web 内部服务返回了不符合契约的数据。',
    });
  }

  /** 读取节点后测所需的固定内容上下文。 */
  async getCardContentContext(agentRunId: string): Promise<CardContentContextEnvelope> {
    return this.request({
      method: 'GET',
      path: '/agent-runs/' + agentRunId + '/card-content-context',
      timeoutMs: 15_000,
      notFoundCode: 'CARD_CONTENT_CONTEXT_NOT_FOUND',
      notFoundMessage: '节点内容不存在或尚未 ready。',
      rejectedCode: 'CARD_CONTENT_CONTEXT_INVALID',
      rejectedMessage: 'Web 内部服务拒绝了节点内容上下文读取。',
      schema: CardContentContextEnvelopeSchema,
      invalidMessage: 'Web 内部服务返回了不符合内容上下文契约的数据。',
    });
  }

  /** 幂等持久化已校验题集。 */
  async persistAssessment(
    agentRunId: string,
    payload: Record<string, unknown>,
  ): Promise<PersistedAssessmentEnvelope> {
    return this.request({
      method: 'POST',
      path: '/agent-runs/' + agentRunId + '/assessment-result',
      body: payload,
      timeoutMs: 15_000,
      notFoundCode: 'AGENT_RUN_NOT_FOUND',
      notFoundMessage: '待持久化的 AgentRun 不存在或类型不匹配。',
      rejectedCode: 'ASSESSMENT_PERSISTENCE_REJECTED',
      rejectedMessage: 'Web 拒绝了题集持久化请求。',
      schema: PersistedAssessmentEnvelopeSchema,
      invalidMessage: 'Web 内部服务返回了不符合契约的数据。',
    });
  }

  /** 幂等持久化已校验学习路线。 */
  async persistLearningPlan(
    agentRunId: string,
    payload: Record<string, unknown>,
  ): Promise<PersistedLearningPlanEnvelope> {
    return this.request({
      method: 'POST',
      path: '/agent-runs/' + agentRunId + '/plan-result',
      body: payload,
      timeoutMs: 20_000,
      notFoundCode: 'AGENT_RUN_NOT_FOUND',
      notFoundMessage: '待持久化的 AgentRun 不存在或类型不匹配。',
      rejectedCode: 'PLAN_PERSISTENCE_REJECTED',
      rejectedMessage: 'Web 拒绝了学习路线持久化请求。',
      schema: PersistedLearningPlanEnvelopeSchema,
      invalidMessage: 'Web 内部服务返回了不符合契约的数据。',
    });
  }

  /** 幂等持久化已校验的节点知识内容。 */
  async persistCardContent(
    agentRunId: string,
    payload: Record<string, unknown>,
  ): Promise<PersistedCardContentEnvelope> {
    return this.request({
      method: 'POST',
      path: '/agent-runs/' + agentRunId + '/card-content-result',
      body: payload,
      timeoutMs: 20_000,
      notFoundCode: 'AGENT_RUN_NOT_FOUND',
      notFoundMessage: '待持久化的 AgentRun 不存在或类型不匹配。',
      rejectedCode: 'CARD_CONTENT_PERSISTENCE_REJECTED',
      rejectedMessage: 'Web 拒绝了节点内容持久化请求。',
      schema: PersistedCardContentEnvelopeSchema,
      invalidMessage: 'Web 内部服务返回了不符合契约的数据。',
    });
  }

  private async request<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    timeoutMs: number;
    notFoundCode: string;
    notFoundMessage: string;
    rejectedCode: string;
    rejectedMessage: string;
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
    invalidMessage: string;
  }): Promise<T> {
    if (this.secret === null || this.secret.length === 0) {
      throw new CoreInternalClientError(
        INTERNAL_SERVICE_SECRET_MISSING,
        'Worker 与 Web 的内部服务密钥尚未配置。',
        false,
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'LearnCraft-Agent/0.1',
      [INTERNAL_SERVICE_SECRET_HEADER]: this.secret,
    };
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + input.path, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch {
      throw new CoreInternalClientError('CORE_INTERNAL_UNAVAILABLE', 'Web 内部服务暂时不可用。', true);
    }

    if (response.status === 404) {
      throw new CoreInternalClientError(input.notFoundCode, input.notFoundMessage, false);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CoreInternalClientError('CORE_INTERNAL_AUTH_FAILED', 'Worker 无法通过 Web 内部服务鉴权。', false);
    }
    if (response.status >= 500) {
      throw new CoreInternalClientError('CORE_INTERNAL_UNAVAILABLE', 'Web 内部服务暂时不可用。', true);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CoreInternalClientError(input.rejectedCode, input.rejectedMessage, false);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CoreInternalClientError('CORE_INTERNAL_RESPONSE_INVALID', input.invalidMessage, false);
    }
    const parsed = input.schema.safeParse(payload);
    if (!parsed.success) {
      throw new CoreInternalClientError('CORE_INTERNAL_RESPONSE_INVALID', input.invalidMessage, false);
    }
    return parsed.data;
  }
}
