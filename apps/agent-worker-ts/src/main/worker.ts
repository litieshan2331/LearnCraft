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
  readAgentQueueConfig,
  readAgentReactMaxTurns,
  readAgentToolMaxCalls,
  readCoreInternalClientOptions,
  readModelEgressAuditRetentionDays,
  readModelEgressOptions,
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
  const queueConfig = readAgentQueueConfig();
  const pool = new pg.Pool({ connectionString: requireDatabaseUrl(), max: 12 });
  const repository = new PgAgentRunRepository(pool);

  const internalClient = new CoreInternalClient(readCoreInternalClientOptions());
  const decryptor = ModelCredentialDecryptor.fromEnvironment();
  // 审计写入是出网的 fail-closed 前置条件：写不进审计就拒绝调用模型。
  const auditWriter = new PgModelEgressAuditRepository(pool, readModelEgressAuditRetentionDays());
  const egress = new SafeModelEgressClient(readModelEgressOptions(), auditWriter);
  const gateway = new OpenAiCompatibleModelGateway(egress, Number(process.env.MODEL_GATEWAY_REQUEST_MAX_RETRIES ?? 5));

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

  const workflows = new AgentWorkflowRegistry();
  const workflowDeps = { internalClient, decryptor, gateway, createToolGateway, maxToolCalls };
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

  const worker = createAgentRunWorker(
    queueConfig,
    createAgentRunProcessor({ repository, workflows, maxRetries: queueConfig.maxAttempts }),
  );

  // 健康与就绪端点：Python 侧 agent-api 下线后，运维与 compose healthcheck 依赖它判断 Agent 侧状态。
  const readinessRedis = new RespRedisClient({ url: formatRedisConnection(queueConfig.connection) });
  const health = await startHealthServer({
    service: 'agent-worker-ts',
    port: Number(process.env.AGENT_HTTP_PORT ?? 8080),
    host: process.env.AGENT_HTTP_HOST ?? '0.0.0.0',
    details: () => ({
      queue: queueConfig.queueName,
      queue_prefix: queueConfig.prefix,
      concurrency: queueConfig.concurrency,
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
  worker.on('failed', (job, error) => {
    console.error('[worker] 任务失败 run=' + String(job?.id) + ' attempts=' + String(job?.attemptsMade) + '：' + error.message);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[worker] 收到 ' + signal + '，等待在飞任务结束');
    await health.close();
    await worker.close();
    await pool.end();
    await readinessRedis.close();
    await redisQuota?.close();
    console.log('[worker] 已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    '[worker] 启动：队列=' + queueConfig.queueName +
      '，前缀=' + queueConfig.prefix +
      '，并发=' + String(queueConfig.concurrency) +
      '，已注册工作流=' + JSON.stringify(workflows.registeredRunTypes()) +
      '，联网工具=' + (tavilySettings.apiKey === null ? '未配置' : '已配置') +
      '，配额 Redis=' + (redisQuota === null ? '未配置' : '已配置') +
      '，工具上限=' + String(maxToolCalls) +
      '，ReAct 轮数=' + JSON.stringify(reactMaxTurns) +
      '，健康端点=:' + String(health.port),
  );
}

main().catch((error: unknown) => {
  console.error('[worker] 启动失败', error);
  process.exit(1);
});
