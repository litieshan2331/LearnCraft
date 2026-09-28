/**
 * Agent Worker 进程入口。
 *
 * 职责：装配内部接口客户端、凭据解密器、受控出网客户端、模型网关、Tavily 联网工具网关与工作流注册表，
 * 启动 BullMQ 消费端与健康端点（/health、/ready），并在收到 SIGTERM/SIGINT 时等待在飞任务结束后关闭。
 *
 * 在飞任务不会被强杀：关闭窗口内未完成的任务由 BullMQ 的锁与 stalled 检测重投，
 * 数据库状态机保证不会重复写入业务结果。
 */

import pg from 'pg';

import { CoreInternalClient } from '../acl/core-internal-client.js';
import { AgentWorkflowRegistry } from '../application/services/agent-workflow-registry.js';
import {
  formatRedisConnection,
  readAgentQueuePoolConfigs,
  readAgentReactMaxTurns,
  readAgentToolMaxCalls,
  readCoreInternalClientOptions,
  readModelEgressAuditRetentionDays,
  readModelEgressOptions,
  readModelRateLimitSettings,
  readTavilyToolSettings,
} from '../bootstrap/config.js';
import { PgAgentRunRepository } from '../infrastructure/database/agent-run-repository.js';
import { PgModelEgressAuditRepository } from '../infrastructure/database/model-egress-audit-repository.js';
import { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../infrastructure/llm/model-gateway.js';
import { SafeModelEgressClient } from '../infrastructure/llm/safe-egress-client.js';
import {
  RedisDailyQuotaCounter,
  TavilyToolGateway,
  type DailyQuotaCounter,
} from '../infrastructure/mcp/tavily-tool-gateway.js';
import { createAgentRunWorker } from '../infrastructure/queue/bullmq-agent-queue.js';
import { createReadinessChecker, startHealthServer } from '../interfaces/http/health-server.js';
import { createAgentRunProcessor } from '../interfaces/queue/agent-run-processor.js';
import { RespRedisClient } from '../infrastructure/redis/resp-client.js';
import { RedisAgentProgressPublisher } from '../infrastructure/redis/agent-progress-publisher.js';
import { RedisModelRateLimiter } from '../infrastructure/redis/model-rate-limiter.js';
import { createAssessmentGenerateWorkflow } from '../workflows/assessment-generate/index.js';
import { createCardContentGenerateWorkflow } from '../workflows/card-content-generate/index.js';
import { createPlanGenerateWorkflow } from '../workflows/plan-generate/index.js';
import { createPosttestGenerateWorkflow } from '../workflows/posttest-generate/index.js';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url === undefined || url.length === 0) {
    throw new Error('缺少必需的环境变量：DATABASE_URL');
  }
  return url;
}

async function main(): Promise<void> {
  const queueConfigs = readAgentQueuePoolConfigs();
  const pool = new pg.Pool({ connectionString: requireDatabaseUrl(), max: 12 });
  const repository = new PgAgentRunRepository(pool);

  const internalClient = new CoreInternalClient(readCoreInternalClientOptions());
  const decryptor = ModelCredentialDecryptor.fromEnvironment();
  // 审计写入是出网的 fail-closed 前置条件：写不进审计就拒绝调用模型。
  const auditWriter = new PgModelEgressAuditRepository(pool, readModelEgressAuditRetentionDays());
  const egress = new SafeModelEgressClient(readModelEgressOptions(), auditWriter);
  const rateLimitRedis = new RespRedisClient({
    url: formatRedisConnection(queueConfigs.short.connection),
    connectTimeoutMs: 2_000,
    commandTimeoutMs: 2_000,
  });
  const rateLimiter = new RedisModelRateLimiter(rateLimitRedis, readModelRateLimitSettings());
  const gateway = new OpenAiCompatibleModelGateway(
    egress,
    Number(process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES ?? 5),
    undefined,
    rateLimiter,
  );

  // 联网工具：Key 或配额 Redis 缺失时不阻止启动，网关会把受控错误回传给模型（Python 同行为）。
  const tavilySettings = readTavilyToolSettings();
  const redisQuota =
    tavilySettings.quotaRedisUrl === null ? null : new RedisDailyQuotaCounter(tavilySettings.quotaRedisUrl);
  const quota: DailyQuotaCounter = redisQuota ?? {
    increment: async () => null,
    decrement: async () => undefined,
  };
  const maxToolCalls = readAgentToolMaxCalls();
  // ReAct 轮数按工作流分别注入（一次运行内允许的模型调用次数，含工具调用轮）。
  const reactMaxTurns = readAgentReactMaxTurns();
  const createToolGateway = (ownerId: string) =>
    new TavilyToolGateway({
      settings: {
        apiKey: tavilySettings.apiKey,
        ownerId,
        dailyLimit: tavilySettings.dailyLimit,
        quotaKeyPrefix: tavilySettings.quotaKeyPrefix,
        searchMaxResults: tavilySettings.searchMaxResults,
        extractTopResults: tavilySettings.extractTopResults,
        extractChunksPerSource: tavilySettings.extractChunksPerSource,
        proxyUrl: tavilySettings.proxyUrl,
      },
      quota,
    });

  // 实时进度（B2）：与队列共用 Redis 实例，发布到 learncraft:agent-progress:{runId}。
  // 通道不可用时只告警，绝不影响 AgentRun；web 侧未配置订阅时这些事件也不会有人读取。
  const progressPublisher = new RedisAgentProgressPublisher({
    url: formatRedisConnection(queueConfigs.short.connection),
    commandTimeoutMs: 1_000,
    // 思考原文单条上限（默认 200 会截断）；其余事件字段都很短，放宽不影响其它事件。
    maxTextLength: 4_000,
  });
  const createProgressReporter = (runId: string) => progressPublisher.createReporter(runId);

  const workflows = new AgentWorkflowRegistry();
  const workflowDeps = { internalClient, decryptor, gateway, createToolGateway, maxToolCalls, createProgressReporter };
  workflows.register('assessment_generate', createAssessmentGenerateWorkflow({
    ...workflowDeps,
    reactMaxTurns: reactMaxTurns.assessmentGenerate,
  }));
  workflows.register('posttest_generate', createPosttestGenerateWorkflow({
    ...workflowDeps,
    reactMaxTurns: reactMaxTurns.posttestGenerate,
  }));
  workflows.register('plan_generate', createPlanGenerateWorkflow({
    ...workflowDeps,
    reactMaxTurns: reactMaxTurns.planGenerate,
  }));
  workflows.register('card_content_generate', createCardContentGenerateWorkflow({
    ...workflowDeps,
    reactMaxTurns: reactMaxTurns.cardContentGenerate,
  }));

  const workers = {
    short: createAgentRunWorker(
      queueConfigs.short,
      createAgentRunProcessor({ repository, workflows, maxRetries: queueConfigs.short.maxAttempts }),
    ),
    long: createAgentRunWorker(
      queueConfigs.long,
      createAgentRunProcessor({ repository, workflows, maxRetries: queueConfigs.long.maxAttempts }),
    ),
  };

  // 健康与就绪端点：Python 侧 agent-api 下线后，运维与 compose healthcheck 依赖它判断 Agent 侧状态。
  const readinessRedis = new RespRedisClient({ url: formatRedisConnection(queueConfigs.short.connection) });
  const health = await startHealthServer({
    service: 'agent-worker-ts',
    port: Number(process.env.AGENT_HTTP_PORT ?? 8080),
    host: process.env.AGENT_HTTP_HOST ?? '0.0.0.0',
    details: () => ({
      queues: { short: queueConfigs.short.queueName, long: queueConfigs.long.queueName },
      queue_prefix: queueConfigs.short.prefix,
      concurrency: { short: queueConfigs.short.concurrency, long: queueConfigs.long.concurrency },
      registered_run_types: workflows.registeredRunTypes(),
      tavily_configured: tavilySettings.apiKey !== null,
      tavily_quota_configured: redisQuota !== null,
      tool_max_calls: maxToolCalls,
      react_max_turns: reactMaxTurns,
    }),
    readiness: createReadinessChecker({
      database: async () => {
        await pool.query('SELECT 1');
      },
      queue_redis: async () => {
        const reply = await readinessRedis.command('PING');
        if (reply !== 'PONG') {
          throw new Error('Redis 未返回 PONG。');
        }
      },
    }),
  });
  for (const [pool, worker] of Object.entries(workers)) {
    worker.on('failed', (job, error) => {
      console.error('[worker] ' + pool + ' 任务失败 run=' + String(job?.id) + ' attempts=' + String(job?.attemptsMade) + '：' + error.message);
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[worker] 收到 ' + signal + '，等待在飞任务结束');
    await health.close();
    await Promise.all([workers.short.close(), workers.long.close()]);
    await pool.end();
    await readinessRedis.close();
    await rateLimitRedis.close();
    await progressPublisher.close();
    await redisQuota?.close();
    console.log('[worker] 已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    '[worker] 启动：短队列=' + queueConfigs.short.queueName + '，长队列=' + queueConfigs.long.queueName +
      '，前缀=' + queueConfigs.short.prefix +
      '，并发=' + String(queueConfigs.short.concurrency) + '/' + String(queueConfigs.long.concurrency) +
      '，已注册工作流=' + JSON.stringify(workflows.registeredRunTypes()) +
      '，联网工具=' + (tavilySettings.apiKey === null ? '未配置' : '已配置') +
      '，配额 Redis=' + (redisQuota === null ? '未配置' : '已配置') +
      '，工具上限=' + String(maxToolCalls) +
      '，ReAct 轮数=' + JSON.stringify(reactMaxTurns) +
      '，实时进度=已启用' +
      '，健康端点=:' + String(health.port),
  );
}

main().catch((error: unknown) => {
  console.error('[worker] 启动失败', error);
  process.exit(1);
});
