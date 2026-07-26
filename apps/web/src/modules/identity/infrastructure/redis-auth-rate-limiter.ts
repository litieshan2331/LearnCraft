/**
 * Redis 认证限流基础设施适配器。
 *
 * 导出：
 * - RedisAuthenticationRateLimiter：以原子固定窗口计数限制注册与登录请求；Redis 故障会向应用层抛错，由其映射为 503。
 */

import { createHash } from "node:crypto";

import { createClient } from "redis";

import type {
  AuthenticationRateLimiter,
  RateLimitDecision,
  RateLimitPolicy,
} from "../domain/authentication";

const INCREMENT_FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

// LearnCraft 约定 Redis 只使用 DB 0；业务隔离完全依赖键前缀，便于后续接入 Sentinel。
const REDIS_DATABASE = 0;

let redisClientPromise: ReturnType<typeof connectRedis> | undefined;

export class RedisAuthenticationRateLimiter implements AuthenticationRateLimiter {
  async consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision> {
    const redisClient = await getRedisClient();
    const key = createRateLimitKey(policy, subject);
    const reply = await redisClient.eval(INCREMENT_FIXED_WINDOW_SCRIPT, {
      keys: [key],
      arguments: [String(policy.windowSeconds)],
    }) as unknown as [number | string, number | string];
    const count = Number(reply[0]);
    const ttl = Math.max(1, Number(reply[1]));

    return {
      allowed: count <= policy.limit,
      retryAfterSeconds: ttl,
    };
  }
}

async function getRedisClient(): ReturnType<typeof connectRedis> {
  redisClientPromise ??= connectRedis().catch((error: unknown) => {
    redisClientPromise = undefined;
    throw error;
  });

  const redisClient = await redisClientPromise;
  if (!redisClient.isReady) {
    redisClientPromise = undefined;
    return getRedisClient();
  }

  return redisClient;
}

function connectRedis() {
  const host = getRequiredEnvironmentVariable("REDIS_HOST");
  const password = getRequiredEnvironmentVariable("REDIS_PASSWORD");
  const port = getRedisPort();
  const client = createClient({
    database: REDIS_DATABASE,
    socket: {
      host,
      port,
      connectTimeout: 2_000,
      reconnectStrategy: false,
    },
    password,
    disableOfflineQueue: true,
  });

  // 连接错误由当前认证请求处理为 503，避免未监听的 error 事件终止 Node 进程。
  client.on("error", () => undefined);
  return client.connect();
}

export function createRateLimitKey(policy: RateLimitPolicy, subject: string): string {
  const subjectHash = createHash("sha256").update(subject).digest("hex");
  return `ratelimit:${policy.name}:${subjectHash}`;
}

function getRedisPort(): number {
  const port = Number(process.env.REDIS_PORT ?? "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REDIS_PORT 必须是 1 到 65535 的整数。");
  }

  return port;
}

function getRequiredEnvironmentVariable(name: "REDIS_HOST" | "REDIS_PASSWORD"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置，认证限流不可用。`);
  }

  return value;
}
