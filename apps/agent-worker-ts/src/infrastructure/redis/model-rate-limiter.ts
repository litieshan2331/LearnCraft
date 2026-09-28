/**
 * 模型调用的 Redis 分布式限流器。
 *
 * 调用顺序：`acquire` 以 Lua 脚本原子检查并占用全局、API Key+模型、用户+模型三个并发桶，
 * 同时递增 API Key+模型与用户+模型的 RPM 计数；Provider 调用结束后由租约 `release` 释放并发桶。
 * Redis 不可用或额度已满时抛出可重试错误；本实现不做 TPM、成本预算或 Provider 专属额度。
 */

import { createHash } from 'node:crypto';

import { RespRedisClient } from './resp-client.js';

/** 限流器使用的模型请求身份，不包含 Base URL。 */
export interface ModelRateLimitRequest {
  ownerId: string;
  modelId: string;
  apiKey: string;
}

/** 一次成功占用的并发租约；调用方必须在 Provider 请求结束后释放。 */
export interface ModelRateLimitLease {
  release(): Promise<void>;
}

/** 网关依赖的最小限流端口，测试可注入假实现。 */
export interface ModelRateLimiter {
  acquire(request: ModelRateLimitRequest): Promise<ModelRateLimitLease>;
}

/** 限流配置；RPM 使用固定 60 秒窗口，并发使用带 TTL 的 Redis 计数器兜底。 */
export interface ModelRateLimitOptions {
  globalConcurrency: number;
  apiKeyConcurrency: number;
  apiKeyRpm: number;
  userConcurrency: number;
  userRpm: number;
  leaseTtlSeconds: number;
  keyPrefix?: string;
}

/** 限流失败错误；网关会把它映射为可重试的 ModelGatewayError。 */
export class ModelRateLimitError extends Error {
  constructor(
    readonly code: 'MODEL_RATE_LIMIT_EXCEEDED' | 'MODEL_RATE_LIMIT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'ModelRateLimitError';
  }
}

const ACQUIRE_SCRIPT = [
  "local global_inflight = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local key_inflight = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "local user_inflight = tonumber(redis.call('GET', KEYS[3]) or '0')",
  "local key_rpm = tonumber(redis.call('GET', KEYS[4]) or '0')",
  "local user_rpm = tonumber(redis.call('GET', KEYS[5]) or '0')",
  "if global_inflight >= tonumber(ARGV[1]) or key_inflight >= tonumber(ARGV[2]) or user_inflight >= tonumber(ARGV[3]) then return 0 end",
  "if key_rpm >= tonumber(ARGV[4]) or user_rpm >= tonumber(ARGV[5]) then return 0 end",
  "local function increment(key, ttl)",
  "  local value = redis.call('INCR', key)",
  "  if value == 1 then redis.call('EXPIRE', key, ttl) end",
  "end",
  "increment(KEYS[1], ARGV[6])",
  "increment(KEYS[2], ARGV[6])",
  "increment(KEYS[3], ARGV[6])",
  "increment(KEYS[4], ARGV[7])",
  "increment(KEYS[5], ARGV[7])",
  'return 1',
].join('\n');

const RELEASE_SCRIPT = [
  "local function release(key)",
  "  local value = redis.call('DECR', key)",
  "  if value <= 0 then redis.call('DEL', key) end",
  "end",
  'release(KEYS[1])',
  'release(KEYS[2])',
  'release(KEYS[3])',
  'return 1',
].join('\n');

/** 使用 Redis Lua 脚本实现跨 Worker 的原子并发与 RPM 限制。 */
export class RedisModelRateLimiter implements ModelRateLimiter {
  private readonly options: Required<ModelRateLimitOptions>;

  constructor(
    private readonly client: RespRedisClient,
    options: ModelRateLimitOptions,
  ) {
    this.options = {
      keyPrefix: 'ratelimit:llm:',
      ...options,
    };
    validateOptions(this.options);
  }

  /** 原子获取三个并发桶，并递增两个 RPM 桶；成功后返回可释放租约。 */
  async acquire(request: ModelRateLimitRequest): Promise<ModelRateLimitLease> {
    const keys = this.buildKeys(request, Math.floor(Date.now() / 60_000));
    let result: string | number | null;
    try {
      result = await this.client.command(
        'EVAL',
        ACQUIRE_SCRIPT,
        '5',
        ...keys,
        String(this.options.globalConcurrency),
        String(this.options.apiKeyConcurrency),
        String(this.options.userConcurrency),
        String(this.options.apiKeyRpm),
        String(this.options.userRpm),
        String(this.options.leaseTtlSeconds),
        '60',
      );
    } catch {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_UNAVAILABLE', '模型限流 Redis 不可用。');
    }
    if (result !== 1) {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_EXCEEDED', '模型调用达到限流额度。');
    }
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        try {
          await this.client.command('EVAL', RELEASE_SCRIPT, '3', keys[0]!, keys[1]!, keys[2]!);
        } catch {
          // 租约 TTL 会兜底释放；不能让一次成功的模型调用因释放失败而变成任务失败。
        }
      },
    };
  }

  /** 根据 API Key+模型、用户+模型和当前分钟生成 Redis 键，不保存明文密钥。 */
  private buildKeys(request: ModelRateLimitRequest, window: number): string[] {
    const modelId = request.modelId.trim();
    const apiKeyScope = digest(request.apiKey.trim() + '\u0000' + modelId);
    const userScope = digest(request.ownerId + '\u0000' + modelId);
    const prefix = this.options.keyPrefix;
    return [
      prefix + 'global:inflight',
      prefix + 'key:inflight:' + apiKeyScope,
      prefix + 'user:inflight:' + userScope,
      prefix + 'key:rpm:' + apiKeyScope + ':' + String(window),
      prefix + 'user:rpm:' + userScope + ':' + String(window),
    ];
  }
}

/** 计算稳定的 SHA-256 分桶标识，避免 API Key、用户或模型名出现在 Redis 键中。 */
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 校验正整数限流配置，避免零值导致所有请求永久被拒绝。 */
function validateOptions(options: Required<ModelRateLimitOptions>): void {
  const values = [
    options.globalConcurrency,
    options.apiKeyConcurrency,
    options.apiKeyRpm,
    options.userConcurrency,
    options.userRpm,
    options.leaseTtlSeconds,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('模型限流参数必须是正整数。');
  }
}

