/**
 * Agent Worker 进程入口。
 *
 * 职责：装配内部接口客户端、凭据解密器、受控出网客户端、模型网关与工作流注册表，
 * 启动 BullMQ 消费端，并在收到 SIGTERM/SIGINT 时等待在飞任务结束后关闭。
 *
 * 在飞任务不会被强杀：关闭窗口内未完成的任务由 BullMQ 的锁与 stalled 检测重投，
 * 数据库状态机保证不会重复写入业务结果。
 */

import pg from 'pg';

import { CoreInternalClient } from '../acl/core-internal-client.js';
import { AgentWorkflowRegistry } from '../application/services/agent-workflow-registry.js';
import {
  readAgentQueueConfig,
  readCoreInternalClientOptions,
  readModelEgressAuditRetentionDays,
  readModelEgressOptions,
} from '../bootstrap/config.js';
import { PgAgentRunRepository } from '../infrastructure/database/agent-run-repository.js';
import { PgModelEgressAuditRepository } from '../infrastructure/database/model-egress-audit-repository.js';
import { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../infrastructure/llm/model-gateway.js';
import { SafeModelEgressClient } from '../infrastructure/llm/safe-egress-client.js';
import { createAgentRunWorker } from '../infrastructure/queue/bullmq-agent-queue.js';
import { createAgentRunProcessor } from '../interfaces/queue/agent-run-processor.js';
import { createAssessmentGenerateWorkflow } from '../workflows/assessment-generate.js';
import { createCardContentGenerateWorkflow } from '../workflows/card-content-generate.js';
import { createPlanGenerateWorkflow } from '../workflows/plan-generate.js';
import { createPosttestGenerateWorkflow } from '../workflows/posttest-generate.js';

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

  const workflows = new AgentWorkflowRegistry();
  const workflowDeps = { internalClient, decryptor, gateway };
  workflows.register('assessment_generate', createAssessmentGenerateWorkflow(workflowDeps));
  workflows.register('posttest_generate', createPosttestGenerateWorkflow(workflowDeps));
  workflows.register('plan_generate', createPlanGenerateWorkflow(workflowDeps));
  workflows.register('card_content_generate', createCardContentGenerateWorkflow(workflowDeps));

  const worker = createAgentRunWorker(
    queueConfig,
    createAgentRunProcessor({ repository, workflows, maxRetries: queueConfig.maxAttempts }),
  );
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
    await worker.close();
    await pool.end();
    console.log('[worker] 已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    '[worker] 启动：队列=' + queueConfig.queueName +
      '，前缀=' + queueConfig.prefix +
      '，并发=' + String(queueConfig.concurrency) +
      '，已注册工作流=' + JSON.stringify(workflows.registeredRunTypes()),
  );
}

main().catch((error: unknown) => {
  console.error('[worker] 启动失败', error);
  process.exit(1);
});
