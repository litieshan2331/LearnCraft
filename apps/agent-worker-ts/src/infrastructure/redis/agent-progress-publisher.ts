/**
 * AgentRun 进度事件的 Redis 发布器（B2：Pub/Sub 临时通道，不落库）。
 *
 * 职责：把 application 层的 AgentProgressReporter 实现为 `PUBLISH learncraft:agent-progress:{runId}`。
 * 三条实现要点：
 * 1. 复用现有 RespRedisClient（不新增依赖），按 URL 连接队列 Redis；
 * 2. 单连接上串行发送（RespRedisClient 一次只处理一条命令），用 promise 链排队；
 * 3. 任何发布错误只告警、不抛出——进度通道不可用绝不能影响 AgentRun 本身。
 *
 * 与前端的分工：worker 只发 step code 与结构化参数，文案由前端映射；
 * 字符串参数在此处做防御性截断，避免超长内容进入通道。
 *
 * 导出：
 * - AGENT_PROGRESS_CHANNEL_PREFIX / agentProgressChannel：频道命名规则（web 侧订阅必须一致）。
 * - RedisAgentProgressPublisherOptions：连接与降级配置。
 * - RedisAgentProgressPublisher：createReporter / close。
 */

import type {
  AgentProgressData,
  AgentProgressEvent,
  AgentProgressReporter,
  AgentProgressStep,
} from '../../application/services/agent-progress.js';
import { RespRedisClient } from './resp-client.js';

/** 频道前缀；web 侧订阅同一规则。 */
export const AGENT_PROGRESS_CHANNEL_PREFIX = 'learncraft:agent-progress:';

/** 由 runId 派生频道名。runId 是已校验的 UUID，不接受任意频道。 */
export function agentProgressChannel(runId: string): string {
  return AGENT_PROGRESS_CHANNEL_PREFIX + runId;
}

export interface RedisAgentProgressPublisherOptions {
  /** 队列 Redis 连接串（与 BullMQ 共用实例，独立频道前缀）。 */
  url: string;
  /** 发布失败时的告警回调，默认写 stderr；绝不向上抛。 */
  onError?: (error: unknown) => void;
  /** 单个字符串参数的最大长度（默认 200），超出截断。 */
  maxTextLength?: number;
  /** 单条命令超时（默认 1000ms）。 */
  commandTimeoutMs?: number;
}

export class RedisAgentProgressPublisher {
  private readonly client: RespRedisClient;
  private readonly onError: (error: unknown) => void;
  private readonly maxTextLength: number;
  /** 串行发送队列：单连接不能被并发命令复用。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RedisAgentProgressPublisherOptions) {
    this.client = new RespRedisClient({
      url: options.url,
      commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
    });
    this.onError = options.onError ?? ((error: unknown) => {
      console.error('[agent-progress] 发布失败（已忽略）', error);
    });
    this.maxTextLength = options.maxTextLength ?? 200;
  }

  /** 为一次运行创建上报器；序号在运行内单调递增。 */
  createReporter(runId: string): AgentProgressReporter {
    let sequence = 0;
    return {
      report: (step: AgentProgressStep, data?: AgentProgressData): void => {
        sequence += 1;
        const event: AgentProgressEvent = {
          v: 1,
          step,
          at: new Date().toISOString(),
          seq: sequence,
          ...(data === undefined ? {} : { data: this.truncate(data) }),
        };
        void this.enqueue(runId, event);
      },
    };
  }

  /** 等待在飞发布结束后关闭连接（进程优雅关闭时调用）。 */
  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.client.close();
  }

  private enqueue(runId: string, event: AgentProgressEvent): Promise<void> {
    this.chain = this.chain
      .then(() => this.client.command('PUBLISH', agentProgressChannel(runId), JSON.stringify(event)))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.onError(error);
      });
    return this.chain;
  }

  /** 字符串参数按上限截断；非字符串原样保留。 */
  private truncate(data: AgentProgressData): AgentProgressData {
    const result: AgentProgressData = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = typeof value === 'string' && value.length > this.maxTextLength
        ? value.slice(0, this.maxTextLength)
        : value;
    }
    return result;
  }
}
