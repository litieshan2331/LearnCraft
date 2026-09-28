/**
 * 进程配置读取（等价于 Python 的 core/config.py 中与队列、Dispatcher 相关的部分）。
 *
 * 职责：把环境变量收敛为受校验的配置对象；所有并发、超时与重试参数都必须来自环境变量，
 * 不允许在代码中硬编码。
 *
 * 导出：
 * - AgentQueueConfig / OutboxDispatcherConfig：队列与投递器配置类型。
 * - parseRedisConnection / formatRedisConnection：redis:// 连接串与 BullMQ 连接参数的互相转换。
 * - readAgentQueueConfig / readOutboxDispatcherConfig：从环境变量读取配置。
 */

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
}

/** 把 BullMQ 连接参数还原为 redis:// 连接串（供就绪探测等需要 URL 的场景使用）。 */
export function formatRedisConnection(options: RedisConnectionOptions): string {
  const auth = options.password === undefined || options.password.length === 0
    ? ''
    : (options.username === undefined || options.username.length === 0 ? ':' : options.username + ':')
      + encodeURIComponent(options.password)
      + '@';
  return 'redis://' + auth + options.host + ':' + String(options.port) + '/' + String(options.db);
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

/** 模型 Redis 限流配置；v1 只限制全局/API Key/用户并发与 RPM，不做 TPM。 */
export interface ModelRateLimitSettings {
  globalConcurrency: number;
  apiKeyConcurrency: number;
  apiKeyRpm: number;
  userConcurrency: number;
  userRpm: number;
  leaseTtlSeconds: number;
  keyPrefix: string;
}

/** 从环境变量读取模型限流参数；缺失时使用 v1 的保守默认值。 */
export function readModelRateLimitSettings(): ModelRateLimitSettings {
  return {
    globalConcurrency: readPositiveInteger('MODEL_RATE_LIMIT_GLOBAL_CONCURRENCY', 8),
    apiKeyConcurrency: readPositiveInteger('MODEL_RATE_LIMIT_API_KEY_CONCURRENCY', 2),
    apiKeyRpm: readPositiveInteger('MODEL_RATE_LIMIT_API_KEY_RPM', 30),
    userConcurrency: readPositiveInteger('MODEL_RATE_LIMIT_USER_CONCURRENCY', 2),
    userRpm: readPositiveInteger('MODEL_RATE_LIMIT_USER_RPM', 10),
    leaseTtlSeconds: readPositiveInteger('MODEL_RATE_LIMIT_LEASE_TTL_SECONDS', 180),
    keyPrefix: process.env.MODEL_RATE_LIMIT_KEY_PREFIX?.trim() || 'ratelimit:llm:',
  };
}

/** Tavily 熔断器参数：连续服务故障达到阈值后冷却，随后仅放行单个半开探测。 */
export interface TavilyCircuitBreakerSettings {
  failureThreshold: number;
  failureWindowSeconds: number;
  cooldownSeconds: number;
  probeLeaseSeconds: number;
  keyPrefix: string;
}

/** 读取 Tavily 熔断配置；所有阈值与时间均可通过环境变量覆盖。 */
export function readTavilyCircuitBreakerSettings(): TavilyCircuitBreakerSettings {
  return {
    failureThreshold: readPositiveInteger('TAVILY_CIRCUIT_FAILURE_THRESHOLD', 3),
    failureWindowSeconds: readPositiveInteger('TAVILY_CIRCUIT_FAILURE_WINDOW_SECONDS', 60),
    cooldownSeconds: readPositiveInteger('TAVILY_CIRCUIT_COOLDOWN_SECONDS', 60),
    probeLeaseSeconds: readPositiveInteger('TAVILY_CIRCUIT_PROBE_LEASE_SECONDS', 30),
    keyPrefix: process.env.TAVILY_CIRCUIT_KEY_PREFIX?.trim() || 'circuit:tool:',
  };
}

/** 模型网关请求级额外重试次数，限制在 1–2 次，缺省一次。 */
export function readModelGatewayRequestMaxRetries(): number {
  const retries = readPositiveInteger('MODEL_GATEWAY_REQUEST_MAX_RETRIES', 1);
  return Math.min(2, Math.max(1, retries));
}

/** 读取服务端全局备用模型配置；四项同时配置才启用，模型名称与 Key 不会下发给用户。 */
export interface ModelFallbackSettings {
  enabled: boolean;
  baseUrl: string | null;
  modelId: string | null;
  apiKey: string | null;
  dailyTokenLimit: number;
  keyPrefix: string;
}

/** 校验备用模型配置，避免只配置部分凭据导致运行时静默降级失败。 */
export function readModelFallbackSettings(): ModelFallbackSettings {
  const baseUrl = process.env.MODEL_FALLBACK_BASE_URL?.trim() || null;
  const modelId = process.env.MODEL_FALLBACK_MODEL_ID?.trim() || null;
  const apiKey = process.env.MODEL_FALLBACK_API_KEY?.trim() || null;
  const enabled = (process.env.MODEL_FALLBACK_ENABLED?.trim() || 'false') === 'true';
  if (enabled && (baseUrl === null || modelId === null || apiKey === null)) {
    throw new Error('启用备用模型时必须同时配置 MODEL_FALLBACK_BASE_URL、MODEL_FALLBACK_MODEL_ID、MODEL_FALLBACK_API_KEY。');
  }
  return {
    enabled,
    baseUrl,
    modelId,
    apiKey,
    dailyTokenLimit: readPositiveInteger('MODEL_FALLBACK_DAILY_TOKEN_LIMIT', 100_000),
    keyPrefix: process.env.MODEL_FALLBACK_KEY_PREFIX?.trim() || 'quota:llm:fallback:',
  };
}

/** 出网审计保留天数（与 Python 的 MODEL_EGRESS_AUDIT_RETENTION_DAYS 同名同默认）。 */
export interface TavilySettingsFromEnvironment {
  apiKey: string | null;
  quotaRedisUrl: string | null;
  quotaKeyPrefix: string;
  dailyLimit: number;
  searchMaxResults: number;
  extractTopResults: number;
  extractChunksPerSource: number;
  proxyUrl: string | null;
}

/** 读取 Tavily 联网工具配置；Key 或配额 Redis 缺失时不报错，由网关返回受控工具错误。 */
export function readTavilyToolSettings(): TavilySettingsFromEnvironment {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  const quotaRedisUrl = process.env.TAVILY_QUOTA_REDIS_URL?.trim();
  const proxyUrl = process.env.MODEL_EGRESS_PROXY_URL?.trim();
  return {
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    quotaRedisUrl: quotaRedisUrl !== undefined && quotaRedisUrl.length > 0 ? quotaRedisUrl : null,
    quotaKeyPrefix: process.env.TAVILY_QUOTA_KEY_PREFIX?.trim() || 'ratelimit:tavily:daily:',
    dailyLimit: readPositiveInteger('TAVILY_DAILY_TOOL_CALL_LIMIT', 20),
    searchMaxResults: readPositiveInteger('TAVILY_SEARCH_MAX_RESULTS', 5),
    extractTopResults: readPositiveInteger('TAVILY_EXTRACT_TOP_RESULTS', 2),
    extractChunksPerSource: readPositiveInteger('TAVILY_EXTRACT_CHUNKS_PER_SOURCE', 3),
    proxyUrl: proxyUrl !== undefined && proxyUrl.length > 0 ? proxyUrl : null,
  };
}

/** 读取可见工具调用上限（Python 的 AGENT_TOOL_MAX_CALLS）。 */
export function readAgentToolMaxCalls(): number {
  return readPositiveInteger('AGENT_TOOL_MAX_CALLS', 3);
}

/** 各工作流的 ReAct 轮数上限：一次运行内允许的模型调用次数（含只产生工具调用的轮次）。 */
export interface AgentReactTurnsConfig {
  assessmentGenerate: number;
  posttestGenerate: number;
  planGenerate: number;
  cardContentGenerate: number;
}

/**
 * 读取四个工作流各自的 ReAct 轮数上限；四个工作流的复杂度差异较大，因此分别注入，
 * 由 `AGENT_REACT_MAX_TURNS_*` 环境变量覆盖，默认值见下（plan 需要更多轮次完成 6-12 章路线）。
 */
export function readAgentReactMaxTurns(): AgentReactTurnsConfig {
  return {
    assessmentGenerate: readPositiveInteger('AGENT_REACT_MAX_TURNS_ASSESSMENT', 5),
    posttestGenerate: readPositiveInteger('AGENT_REACT_MAX_TURNS_POSTTEST', 5),
    planGenerate: readPositiveInteger('AGENT_REACT_MAX_TURNS_PLAN', 10),
    cardContentGenerate: readPositiveInteger('AGENT_REACT_MAX_TURNS_CARD_CONTENT', 10),
  };
}

/** 读取正整数环境变量；缺失或非法时回退默认值。 */
function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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

/** 分别读取短、长任务池的队列与并发配置，保留通用重试和连接参数。 */
export function readAgentQueuePoolConfigs(): { short: AgentQueueConfig; long: AgentQueueConfig } {
  const shared = readAgentQueueConfig();
  const shortQueueName = process.env.AGENT_SHORT_QUEUE_NAME?.trim() || shared.queueName;
  const longQueueName = process.env.AGENT_LONG_QUEUE_NAME?.trim() || 'agent.run.long';
  if (shortQueueName === longQueueName) {
    throw new Error('短任务队列与长任务队列不能同名。');
  }
  const shortConcurrency = numberEnv('AGENT_SHORT_WORKER_CONCURRENCY', shared.concurrency);
  const longConcurrency = numberEnv('AGENT_LONG_WORKER_CONCURRENCY', shared.concurrency);
  if (!Number.isInteger(shortConcurrency) || shortConcurrency < 1 || !Number.isInteger(longConcurrency) || longConcurrency < 1) {
    throw new Error('短任务与长任务 Worker 并发必须是正整数。');
  }
  return {
    short: { ...shared, queueName: shortQueueName, concurrency: shortConcurrency },
    long: { ...shared, queueName: longQueueName, concurrency: longConcurrency },
  };
}
export function readOutboxDispatcherConfig(): OutboxDispatcherConfig {
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
  };
}
