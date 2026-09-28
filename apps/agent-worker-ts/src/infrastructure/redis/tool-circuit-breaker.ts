/**
 * Tavily 熔断器的 Redis 状态机。
 *
 * 调用顺序：`acquire` 原子检查 Closed/Open/Half-Open 并发放常规或探测租约；
 * 工具请求成功调用 `recordSuccess` 关闭熔断，连续服务故障调用 `recordFailure` 累计阈值并打开熔断。
 * Redis 不可用时 fail-closed，调用方将工具标记为暂不可用。
 */

import { RespRedisClient } from './resp-client.js';

/** 熔断状态读取与更新端口。 */
export interface ToolCircuitBreaker {
  acquire(): Promise<ToolCircuitLease | null>;
  recordSuccess(lease: ToolCircuitLease): Promise<void>;
  recordFailure(lease: ToolCircuitLease): Promise<void>;
}

/** 表示获准执行的常规调用或半开探测调用。 */
export interface ToolCircuitLease {
  probe: boolean;
}

/** 熔断器配置。 */
export interface ToolCircuitBreakerOptions {
  failureThreshold: number;
  failureWindowSeconds: number;
  cooldownSeconds: number;
  probeLeaseSeconds: number;
  keyPrefix?: string;
}

/** Redis 熔断状态不可用错误；工具调用应 fail-closed。 */
export class ToolCircuitBreakerUnavailableError extends Error {
  constructor() {
    super('工具熔断状态 Redis 不可用。');
    this.name = 'ToolCircuitBreakerUnavailableError';
  }
}

const ACQUIRE_SCRIPT = [
  "local state = redis.call('GET', KEYS[1]) or 'closed'",
  "if state == 'open' then",
  "  local now = tonumber(redis.call('TIME')[1])",
  "  local open_until = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "  if now < open_until then return 0 end",
  "  if redis.call('SET', KEYS[4], '1', 'NX', 'EX', ARGV[2]) == false then return 0 end",
  "  redis.call('SET', KEYS[1], 'half_open', 'EX', ARGV[2])",
  '  return 2',
  'end',
  "if state == 'half_open' then return 0 end",
  'return 1',
].join('\n');

const SUCCESS_SCRIPT = [
  "redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])",
  'return 1',
].join('\n');

const FAILURE_SCRIPT = [
  "local state = redis.call('GET', KEYS[1]) or 'closed'",
  "local function openCircuit()",
  "  local now = tonumber(redis.call('TIME')[1])",
  "  redis.call('SET', KEYS[1], 'open', 'EX', tonumber(ARGV[2]) + tonumber(ARGV[3]))",
  "  redis.call('SET', KEYS[2], tostring(now + tonumber(ARGV[2])), 'EX', tonumber(ARGV[2]) + tonumber(ARGV[3]))",
  "  redis.call('DEL', KEYS[3], KEYS[4])",
  'end',
  "if ARGV[1] == '1' or state == 'half_open' then openCircuit(); return 1 end",
  "local failures = redis.call('INCR', KEYS[3])",
  "if failures == 1 then redis.call('EXPIRE', KEYS[3], ARGV[3]) end",
  "if failures >= tonumber(ARGV[4]) then openCircuit(); return 1 end",
  'return 0',
].join('\n');

/** 基于 Redis Lua 实现多 Worker 共享的 Tavily Closed/Open/Half-Open 熔断器。 */
export class RedisToolCircuitBreaker implements ToolCircuitBreaker {
  private readonly keys: [string, string, string, string];
  private readonly options: Required<ToolCircuitBreakerOptions>;

  constructor(
    private readonly client: RespRedisClient,
    options: ToolCircuitBreakerOptions,
  ) {
    this.options = { keyPrefix: 'circuit:tool:', ...options };
    validateOptions(this.options);
    this.keys = [
      this.options.keyPrefix + 'tavily:state',
      this.options.keyPrefix + 'tavily:open-until',
      this.options.keyPrefix + 'tavily:failures',
      this.options.keyPrefix + 'tavily:probe',
    ];
  }

  /** 获得常规调用租约；Open 状态只在冷却结束后放行单个 Half-Open 探测。 */
  async acquire(): Promise<ToolCircuitLease | null> {
    let result: string | number | null;
    try {
      result = await this.client.command(
        'EVAL',
        ACQUIRE_SCRIPT,
        '4',
        ...this.keys,
        String(this.options.probeLeaseSeconds),
      );
    } catch {
      throw new ToolCircuitBreakerUnavailableError();
    }
    if (result === 0) {
      return null;
    }
    if (result !== 1 && result !== 2) {
      throw new ToolCircuitBreakerUnavailableError();
    }
    return { probe: result === 2 };
  }

  /** 成功调用关闭熔断并清除失败、冷却与探测状态。 */
  async recordSuccess(_lease: ToolCircuitLease): Promise<void> {
    try {
      await this.client.command('EVAL', SUCCESS_SCRIPT, '4', ...this.keys);
    } catch {
      throw new ToolCircuitBreakerUnavailableError();
    }
  }

  /** 记录一次服务故障；达到阈值或半开探测失败时重新打开熔断。 */
  async recordFailure(lease: ToolCircuitLease): Promise<void> {
    try {
      await this.client.command(
        'EVAL',
        FAILURE_SCRIPT,
        '4',
        ...this.keys,
        lease.probe ? '1' : '0',
        String(this.options.cooldownSeconds),
        String(this.options.failureWindowSeconds),
        String(this.options.failureThreshold),
      );
    } catch {
      throw new ToolCircuitBreakerUnavailableError();
    }
  }
}

/** 校验熔断阈值与时间窗口均为正整数。 */
function validateOptions(options: Required<ToolCircuitBreakerOptions>): void {
  if ([options.failureThreshold, options.failureWindowSeconds, options.cooldownSeconds, options.probeLeaseSeconds]
    .some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('工具熔断器配置必须为正整数。');
  }
}
