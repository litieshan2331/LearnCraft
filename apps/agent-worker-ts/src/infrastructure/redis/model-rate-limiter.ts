/**
 * 模型调用的 Redis 分布式限流器。
 *
 * 调用顺序：`acquire` 以 Lua 脚本原子检查并占用全局、API Key+模型、用户+模型三个并发桶，
 * 同时递增 API Key+模型与用户+模型的固定窗口 RPM；独立许可定期 renew，Provider 结束后 release 自己。
 * Redis 不可用或额度已满时抛出可重试错误；本实现不做 TPM、成本预算或 Provider 专属额度。
 */

import { createHash, randomUUID } from 'node:crypto';

import { RespRedisClient } from './resp-client.js';

/** 限流器使用的模型请求身份，不包含 Base URL。 */
export interface ModelRateLimitRequest {
  ownerId: string;
  modelId: string;
  apiKey: string;
}

/** 一次成功占用的并发租约；调用方必须在 Provider 请求结束后释放。 */
export interface ModelRateLimitLease {
  /** 脱敏验证所用的唯一许可标识与 Redis 固定分钟窗口。 */
  leaseId?: string;
  window?: number;
  /** 许可续期失败或失效时中止实际模型请求；测试适配器可不提供。 */
  signal?: AbortSignal;
  /** 出网前再次确认许可有效；不重复消耗 RPM。 */
  renew?(): Promise<void>;
  release(): Promise<void>;
}

/** 网关依赖的最小限流端口，测试可注入假实现。 */
export interface ModelRateLimiter {
  acquire(request: ModelRateLimitRequest): Promise<ModelRateLimitLease>;
}

/** 限流配置；RPM 使用 Redis 时钟的固定分钟窗口，并发使用独立许可与续期。 */
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
    readonly code: 'MODEL_RATE_LIMIT_EXCEEDED' | 'MODEL_RATE_LIMIT_UNAVAILABLE' | 'MODEL_RATE_LIMIT_LEASE_LOST',
    message: string,
  ) {
    super(message);
    this.name = 'ModelRateLimitError';
  }
}

const ACQUIRE_SCRIPT = [
  "local time = redis.call('TIME')",
  "local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)",
  "local window = math.floor(now / 60000)",
  "local key_rpm_key = KEYS[4] .. ':' .. window",
  "local user_rpm_key = KEYS[5] .. ':' .. window",
  "for i = 1, 3 do",
  "  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)",
  "  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i]) then return 0 end",
  "end",
  "local key_rpm = tonumber(redis.call('GET', key_rpm_key) or '0')",
  "local user_rpm = tonumber(redis.call('GET', user_rpm_key) or '0')",
  "if key_rpm >= tonumber(ARGV[4]) or user_rpm >= tonumber(ARGV[5]) then return 0 end",
  "for i = 1, 3 do",
  "  redis.call('ZADD', KEYS[i], now + tonumber(ARGV[6]), ARGV[7])",
  "  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[6]) * 2)",
  "end",
  "local function increment(key, ttl)",
  "  local value = redis.call('INCR', key)",
  "  if value == 1 then redis.call('EXPIRE', key, ttl) end",
  "end",
  "increment(key_rpm_key, 120)",
  "increment(user_rpm_key, 120)",
  "return cjson.encode({window = window, lease_id = ARGV[7]})",
].join('\n');

/** 仅续期仍有效且三个桶中都存在的同一许可；失效后绝不复活。 */
const RENEW_SCRIPT = [
  "local time = redis.call('TIME')",
  "local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)",
  "for i = 1, 3 do",
  "  local expires = redis.call('ZSCORE', KEYS[i], ARGV[1])",
  "  if not expires or tonumber(expires) <= now then",
  "    for j = 1, 3 do redis.call('ZREM', KEYS[j], ARGV[1]) end",
  "    return 0",
  "  end",
  "end",
  "for i = 1, 3 do",
  "  redis.call('ZADD', KEYS[i], now + tonumber(ARGV[2]), ARGV[1])",
  "  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2]) * 2)",
  "end",
  'return 1',
].join('\n');

const RELEASE_SCRIPT = [
  "for i = 1, 3 do redis.call('ZREM', KEYS[i], ARGV[1]) end",
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
    const keys = this.buildKeys(request);
    const leaseId = randomUUID();
    const ttlMs = this.options.leaseTtlSeconds * 1_000;
    const sentAt = performance.now();
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
        String(ttlMs),
        leaseId,
      );
    } catch {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_UNAVAILABLE', '模型限流 Redis 不可用。');
    }
    if (result === 0) {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_EXCEEDED', '模型调用达到限流额度。');
    }
    if (typeof result !== 'string') {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_UNAVAILABLE', '模型限流返回异常。');
    }
    let window: number;
    try {
      const parsed = JSON.parse(result) as { window: number; lease_id: string };
      if (!Number.isInteger(parsed.window) || parsed.lease_id !== leaseId) throw new Error('许可响应异常');
      window = parsed.window;
    } catch {
      throw new ModelRateLimitError('MODEL_RATE_LIMIT_UNAVAILABLE', '模型限流许可响应异常。');
    }
    return { ...this.createLease(keys.slice(0, 3), leaseId, ttlMs, sentAt), leaseId, window };
  }

  /** 管理独立许可的串行续期、保守本地截止时间和幂等释放。 */
  private createLease(keys: string[], leaseId: string, ttlMs: number, sentAt: number): ModelRateLimitLease {
    let released = false;
    const controller = new AbortController();
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | null = null;
    /** 失去许可时停止续期并通知模型传输层中止请求。 */
    const invalidate = (error: ModelRateLimitError): void => {
      clearTimeout(heartbeat);
      clearTimeout(deadline);
      controller.abort(error);
    };
    /** 从命令发出时计时，预留 TTL 的 20% 作为网络和事件循环余量。 */
    const armDeadline = (started: number): void => {
      clearTimeout(deadline);
      const remaining = ttlMs * 0.8 - (performance.now() - started);
      if (remaining <= 0) {
        invalidate(new ModelRateLimitError('MODEL_RATE_LIMIT_LEASE_LOST', '模型许可续期超时。'));
        return;
      }
      deadline = setTimeout(() => invalidate(new ModelRateLimitError('MODEL_RATE_LIMIT_LEASE_LOST', '模型许可已失效。')), remaining);
      deadline.unref();
    };
    /** 对自己的有效许可续期；同一许可的并行调用复用正在执行的续期。 */
    const renew = async (): Promise<void> => {
      controller.signal.throwIfAborted();
      if (released) throw new ModelRateLimitError('MODEL_RATE_LIMIT_LEASE_LOST', '模型许可已释放。');
      if (renewal !== null) return renewal;
      const started = performance.now();
      renewal = (async () => {
        try {
          const reply = await this.client.command('EVAL', RENEW_SCRIPT, '3', ...keys, leaseId, String(ttlMs));
          if (reply !== 1) throw new ModelRateLimitError('MODEL_RATE_LIMIT_LEASE_LOST', '模型许可不存在或已到期。');
          controller.signal.throwIfAborted();
          if (!released) armDeadline(started);
          controller.signal.throwIfAborted();
        } catch (error) {
          const mapped = error instanceof ModelRateLimitError ? error : new ModelRateLimitError('MODEL_RATE_LIMIT_UNAVAILABLE', '模型许可续期 Redis 不可用。');
          invalidate(mapped);
          throw mapped;
        }
      })();
      try { await renewal; } finally { renewal = null; }
    };
    /** 完成一次续期后再安排下一次，避免定时任务重叠与未处理拒绝。 */
    const schedule = (): void => {
      heartbeat = setTimeout(async () => {
        try { await renew(); } catch { return; }
        if (!released && !controller.signal.aborted) schedule();
      }, Math.max(10, Math.floor(ttlMs / 3)));
      heartbeat.unref();
    };
    armDeadline(sentAt);
    if (!controller.signal.aborted) schedule();
    return {
      signal: controller.signal,
      renew,
      /** 停止定时器并仅删除自己的许可，迟到释放不会影响其他请求。 */
      release: async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        clearTimeout(heartbeat);
        clearTimeout(deadline);
        await renewal?.catch(() => undefined);
        try {
          await this.client.command('EVAL', RELEASE_SCRIPT, '3', ...keys, leaseId);
        } catch {
          // 租约 TTL 会兜底释放；不能让一次成功的模型调用因释放失败而变成任务失败。
        }
      },
    };
  }

  /** 并发使用版本化 ZSET；RPM 保留原作用域，窗口由 Redis 原子确定。 */
  private buildKeys(request: ModelRateLimitRequest): string[] {
    const modelId = request.modelId.trim();
    const apiKeyScope = digest(request.apiKey.trim() + '\u0000' + modelId);
    const userScope = digest(request.ownerId + '\u0000' + modelId);
    const prefix = this.options.keyPrefix;
    return [
      prefix + 'leases:v2:global',
      prefix + 'leases:v2:key:' + apiKeyScope,
      prefix + 'leases:v2:user:' + userScope,
      prefix + 'key:rpm:' + apiKeyScope,
      prefix + 'user:rpm:' + userScope,
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

