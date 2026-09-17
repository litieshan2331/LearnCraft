/**
 * 进程配置读取（等价于 Python 的 core/config.py 中与队列、Dispatcher 相关的部分）。
 *
 * 职责：把环境变量收敛为受校验的配置对象；所有并发、超时、重试与路由参数都必须来自环境变量，
 * 不允许在代码中硬编码（Plan §3.4）。
 *
 * 导出：
 * - AgentQueueConfig / OutboxDispatcherConfig：队列与投递器配置类型。
 * - parseRedisConnection：把 redis:// 连接串解析为 BullMQ 连接参数。
 * - readAgentQueueConfig / readOutboxDispatcherConfig：从环境变量读取配置。
 */

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
}

export interface AgentQueueConfig {
  connection: RedisConnectionOptions;
  /** BullMQ 键前缀，必须与 Celery 的 learncraft:celery: 完全隔离。 */
  prefix: string;
  queueName: string;
  concurrency: number;
  /** 必须大于任务硬超时，否则长任务会被判定为 stalled 而重投。 */
  lockDurationMs: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMaxMs: number;
}

export type AgentRuntime = 'ts' | 'python';

export interface OutboxDispatcherConfig {
  connection: RedisConnectionOptions;
  queuePrefix: string;
  queueName: string;
  eventType: string;
  databaseUrl: string;
  dispatcherId: string;
  pollIntervalSeconds: number;
  batchSize: number;
  lockTimeoutSeconds: number;
  maxAttempts: number;
  maxBackoffSeconds: number;
  /** 本运行时负责的 run_type 集合；空集合表示不领取任何事件（可用于回滚）。 */
  runTypes: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error('缺少必需的环境变量：' + name);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error('环境变量 ' + name + ' 必须是数字。');
  }
  return parsed;
}

/** 解析 redis:// 或 rediss:// 连接串；不接受其它协议。 */
export function parseRedisConnection(rawUrl: string): RedisConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Redis 连接串不合法。');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('Redis 连接串必须以 redis:// 或 rediss:// 开头。');
  }
  const dbPath = parsed.pathname.replace(/^\//, '');
  const connection: RedisConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number(parsed.port) : 6379,
    db: dbPath.length > 0 ? Number(dbPath) : 0,
  };
  if (parsed.username.length > 0) {
    connection.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password.length > 0) {
    connection.password = decodeURIComponent(parsed.password);
  }
  return connection;
}

/** 读取运行时路由映射：{"assessment_generate":"ts", ...}；未列出的 run_type 不属于任何运行时。 */
export function readRuntimeRoutes(rawJson: string | undefined): Map<string, AgentRuntime> {
  const routes = new Map<string, AgentRuntime>();
  const raw = rawJson?.trim();
  if (raw === undefined || raw.length === 0) {
    return routes;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_RUNTIME_ROUTES 必须是 JSON 对象。');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AGENT_RUNTIME_ROUTES 必须是 JSON 对象。');
  }
  for (const [runType, runtime] of Object.entries(parsed as Record<string, unknown>)) {
    if (runtime !== 'ts' && runtime !== 'python') {
      throw new Error('AGENT_RUNTIME_ROUTES 的值只能是 ts 或 python。');
    }
    routes.set(runType, runtime);
  }
  return routes;
}

/** 模型受控出网配置；生产环境启用出网时必须配置代理（与 Python 的校验一致）。 */
export function readModelEgressOptions(): {
  enabled: boolean;
  proxyUrl: string | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
} {
  const enabled = (process.env.MODEL_EGRESS_ENABLED?.trim() || 'false') === 'true';
  const proxyUrl = process.env.MODEL_EGRESS_PROXY_URL?.trim() || null;
  const environment = process.env.MODEL_EGRESS_ENVIRONMENT?.trim() || 'development';
  if (enabled && environment === 'production' && proxyUrl === null) {
    throw new Error('生产环境启用模型出网时必须配置 MODEL_EGRESS_PROXY_URL。');
  }
  return {
    enabled,
    proxyUrl,
    connectTimeoutMs: numberEnv('MODEL_EGRESS_CONNECT_TIMEOUT_SECONDS', 10) * 1_000,
    readTimeoutMs: numberEnv('MODEL_EGRESS_READ_TIMEOUT_SECONDS', 120) * 1_000,
    maxResponseBytes: numberEnv('MODEL_EGRESS_MAX_RESPONSE_BYTES', 8 * 1024 * 1024),
  };
}

/** 出网审计保留天数（与 Python 的 MODEL_EGRESS_AUDIT_RETENTION_DAYS 同名同默认）。 */
export function readModelEgressAuditRetentionDays(): number {
  return numberEnv('MODEL_EGRESS_AUDIT_RETENTION_DAYS', 30);
}

/** Web 内部接口配置。 */
export function readCoreInternalClientOptions(): { baseUrl: string; internalServiceSecret: string | null } {
  return {
    baseUrl: process.env.CORE_INTERNAL_BASE_URL?.trim() || 'http://web:3000/internal/v1',
    internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET?.trim() || null,
  };
}

export function readAgentQueueConfig(): AgentQueueConfig {
  return {
    connection: parseRedisConnection(requireEnv('AGENT_QUEUE_REDIS_URL')),
    prefix: process.env.AGENT_QUEUE_PREFIX?.trim() || 'learncraft:agent-queue:',
    queueName: process.env.AGENT_QUEUE_NAME?.trim() || 'agent.run',
    concurrency: numberEnv('AGENT_WORKER_CONCURRENCY', 1),
    lockDurationMs: numberEnv('AGENT_JOB_LOCK_DURATION_MS', 660_000),
    maxAttempts: numberEnv('AGENT_JOB_MAX_ATTEMPTS', 3),
    backoffMs: numberEnv('AGENT_JOB_BACKOFF_MS', 10_000),
    backoffMaxMs: numberEnv('AGENT_JOB_BACKOFF_MAX_MS', 300_000),
  };
}

export function readOutboxDispatcherConfig(): OutboxDispatcherConfig {
  const routes = readRuntimeRoutes(process.env.AGENT_RUNTIME_ROUTES);
  const runTypes = [...routes.entries()]
    .filter(([, runtime]) => runtime === 'ts')
    .map(([runType]) => runType)
    .sort();

  return {
    connection: parseRedisConnection(requireEnv('AGENT_QUEUE_REDIS_URL')),
    queuePrefix: process.env.AGENT_QUEUE_PREFIX?.trim() || 'learncraft:agent-queue:',
    queueName: process.env.AGENT_QUEUE_NAME?.trim() || 'agent.run',
    eventType: process.env.OUTBOX_EVENT_TYPE?.trim() || 'agent.run.requested',
    databaseUrl: requireEnv('DATABASE_URL'),
    dispatcherId: process.env.OUTBOX_DISPATCHER_ID?.trim() || 'agent-dispatcher-ts',
    pollIntervalSeconds: numberEnv('OUTBOX_POLL_INTERVAL_SECONDS', 1),
    batchSize: numberEnv('OUTBOX_BATCH_SIZE', 20),
    lockTimeoutSeconds: numberEnv('OUTBOX_LOCK_TIMEOUT_SECONDS', 900),
    maxAttempts: numberEnv('OUTBOX_MAX_ATTEMPTS', 10),
    maxBackoffSeconds: numberEnv('OUTBOX_MAX_BACKOFF_SECONDS', 300),
    runTypes,
  };
}
