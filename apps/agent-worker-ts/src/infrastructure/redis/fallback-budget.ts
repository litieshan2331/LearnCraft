/**
 * 全局备用模型每日请求预算。
 * 调用顺序：allow 在备用调用前检查当日累计值；record 在返回 usage 后按输入与输出 Token 原子递增。
 * 该计数不记录 API Key、提示词或模型正文。
 */

import { RespRedisClient } from './resp-client.js';

export interface FallbackTokenBudget {
  allow(): Promise<void>;
  record(tokens: number): Promise<void>;
}

export class FallbackBudgetExceededError extends Error {
  constructor() {
    super('备用模型达到每日请求上限。');
    this.name = 'FallbackBudgetExceededError';
  }
}

/** 使用 Redis 实现跨 Worker 的备用模型每日请求预算。 */
export class RedisFallbackTokenBudget implements FallbackTokenBudget {
  constructor(
    private readonly client: RespRedisClient,
    private readonly dailyLimit: number,
    private readonly keyPrefix: string,
  ) {}

  /** 检查当日累计 Token；并发调用允许在 usage 记账前短暂超额。 */
  async allow(): Promise<void> {
    const value = await this.client.command('GET', this.key());
    if (value !== null && Number(value) >= this.dailyLimit) throw new FallbackBudgetExceededError();
  }

  /** 按 Provider 返回的实际 usage 记账。 */
  async record(tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const key = this.key();
    const value = await this.client.command('INCRBY', key, String(Math.floor(tokens)));
    if (value === 1) await this.client.command('EXPIRE', key, '172800');
  }

  private key(): string {
    return this.keyPrefix + new Date().toISOString().slice(0, 10);
  }
}
