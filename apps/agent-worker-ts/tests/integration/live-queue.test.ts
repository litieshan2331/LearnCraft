/**
 * 队列链路真实集成测试（连接真实 Redis 与数据库，会写入真实数据；模型调用需 AGENT_TS_LIVE_QUEUE_MODEL=1）。
 *
 * 用例一：BullMQ 发布 → Worker 消费 → 命令层执行真实 assessment_generate → 校验状态、真实 token 与题集落库。
 * 用例二：在真实数据库上校验领取 SQL —— 路由过滤生效，且 FOR UPDATE OF o 不会锁住 agent_runs
 *         （用第二个事务对同一行做 FOR UPDATE NOWAIT 来证明；若写成裸 FOR UPDATE 会得到 55P03）。
 *
 * 开启方式：
 *   AGENT_TS_LIVE_E2E=1                 必需：允许真实数据库写入
 *   AGENT_TS_LIVE_QUEUE_MODEL=1         可选：同时允许真实模型调用（用例一）
 *   AGENT_TS_TEST_DATABASE_URL / AGENT_TS_QUEUE_REDIS_URL / CORE_INTERNAL_BASE_URL /
 *   INTERNAL_SERVICE_SECRET / CREDENTIAL_ENCRYPTION_KEY(_VERSION)
 */
import pg from 'pg';
import { Queue, Worker } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { CoreInternalClient } from '../../src/acl/core-internal-client.js';
import { AgentWorkflowRegistry } from '../../src/application/services/agent-workflow-registry.js';
import { parseRedisConnection, readAgentToolMaxCalls, type AgentQueueConfig } from '../../src/bootstrap/config.js';
import { PgAgentRunRepository } from '../../src/infrastructure/database/agent-run-repository.js';
import { PgModelEgressAuditRepository } from '../../src/infrastructure/database/model-egress-audit-repository.js';
import { ModelCredentialDecryptor } from '../../src/infrastructure/llm/credential-decryptor.js';
import { createLiveTavilyToolGatewayFactory } from '../helpers/live-tavily-gateway.js';
import { OpenAiCompatibleModelGateway } from '../../src/infrastructure/llm/model-gateway.js';
import { SafeModelEgressClient } from '../../src/infrastructure/llm/safe-egress-client.js';
import {
  createAgentQueue,
  createAgentRunWorker,
  publishAgentRun,
} from '../../src/infrastructure/queue/bullmq-agent-queue.js';
import { SQL_CLAIM_EVENTS } from '../../src/infrastructure/queue/outbox-dispatcher.js';
import { createAgentRunProcessor } from '../../src/interfaces/queue/agent-run-processor.js';
import { createAssessmentGenerateWorkflow } from '../../src/workflows/assessment-generate.js';

const { Pool } = pg;

const databaseUrl = process.env.AGENT_TS_TEST_DATABASE_URL;
const redisUrl = process.env.AGENT_TS_QUEUE_REDIS_URL;
const internalBaseUrl = process.env.CORE_INTERNAL_BASE_URL;
const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
const enabled =
  process.env.AGENT_TS_LIVE_E2E === '1'
  && typeof databaseUrl === 'string' && databaseUrl.length > 0
  && typeof redisUrl === 'string' && redisUrl.length > 0
  && typeof internalBaseUrl === 'string' && internalBaseUrl.length > 0
  && typeof internalSecret === 'string' && internalSecret.length > 0;

const withModel = process.env.AGENT_TS_LIVE_QUEUE_MODEL === '1';
const QUESTION_COUNT = 10;

const SQL_INSERT_GOAL = "INSERT INTO public.learning_goals (owner_id, topic, title, description, desired_outcome, profile_version, status, model_connection_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id";
const SQL_INSERT_RUN = "INSERT INTO agent.agent_runs (id, owner_id, run_type, status, target_type, target_id, idempotency_key, trace_id, graph_version, input_schema_version, requested_model_profile, input_summary_json, goal_id, model_connection_id, requested_model_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id";
const SQL_INSERT_OUTBOX = "INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, event_version, payload_json, trace_id, status, available_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now()) RETURNING id";
const SQL_SELECT_CONNECTION = "SELECT id, owner_id, default_model_id FROM public.user_model_connections WHERE status = $1 AND is_default = true ORDER BY created_at LIMIT 1";
const SQL_SELECT_RUN = "SELECT status, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code FROM agent.agent_runs WHERE id = $1";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_AUDIT = "SELECT decision, reason_code, host, port, expires_at FROM public.model_connection_egress_audits WHERE agent_run_id = $1";
const SQL_DELETE_AUDIT = "DELETE FROM public.model_connection_egress_audits WHERE agent_run_id = $1";
const SQL_SELECT_ASSESSMENT = "SELECT a.id, (SELECT count(*)::int FROM public.assessment_items i WHERE i.assessment_id = a.id) AS item_count FROM public.assessments a WHERE a.generation_metadata->>'agent_run_id' = $1";

const queueConfig: AgentQueueConfig = {
  connection: parseRedisConnection(redisUrl ?? 'redis://127.0.0.1:6380'),
  // 集成测试使用独立前缀，避免污染生产队列键。
  prefix: 'learncraft:agent-queue:itest:' + String(process.pid) + ':',
  queueName: 'agent.run',
  concurrency: 1,
  lockDurationMs: 660_000,
  maxAttempts: 3,
  backoffMs: 10_000,
  backoffMaxMs: 300_000,
};

interface Fixture {
  goalId: string;
  runId: string;
  traceId: string;
  ownerId: string;
  connectionId: string;
  modelId: string;
}

async function createFixture(pool: InstanceType<typeof Pool>, title: string, prefix: string): Promise<Fixture> {
  const connectionResult = await pool.query(SQL_SELECT_CONNECTION, ['active']);
  const connection = connectionResult.rows[0] as { id: string; owner_id: string; default_model_id: string } | undefined;
  if (connection === undefined) {
    throw new Error('没有可用的默认模型连接');
  }
  const goalResult = await pool.query(SQL_INSERT_GOAL, [
    connection.owner_id,
    'TypeScript 类型系统入门',
    title,
    '由 apps/agent-worker-ts 的 live-queue 用例创建，可安全删除。',
    '验证队列链路',
    1,
    'draft',
    connection.id,
  ]);
  const goalId = String((goalResult.rows[0] as { id: string }).id);
  const runId = crypto.randomUUID();
  const traceId = prefix + new Date().toISOString();
  await pool.query(SQL_INSERT_RUN, [
    runId,
    connection.owner_id,
    'assessment_generate',
    'queued',
    'learning_goal',
    goalId,
    prefix + runId,
    traceId,
    'assessment_generate.v1',
    'assessment_generate.input.v1',
    'account_default_openai_compatible',
    JSON.stringify({
      topic: 'TypeScript 类型系统入门',
      title: 'TypeScript 类型系统入门',
      question_count: QUESTION_COUNT,
      difficulty: 'normal',
      kind: 'diagnostic',
    }),
    goalId,
    connection.id,
    connection.default_model_id,
  ]);
  return {
    goalId,
    runId,
    traceId,
    ownerId: connection.owner_id,
    connectionId: connection.id,
    modelId: connection.default_model_id,
  };
}

async function waitForTerminalStatus(
  pool: InstanceType<typeof Pool>,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT status FROM agent.agent_runs WHERE id = $1', [runId]);
    const status = String((result.rows[0] as { status: string } | undefined)?.status ?? '');
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 'timeout';
}

describe.skipIf(!enabled)('BullMQ 队列链路（真实 Redis）', () => {
  it('领取 SQL 在真实库上生效：路由过滤正确，且 FOR UPDATE OF o 不锁 agent_runs', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const fixture = await createFixture(pool, 'TS 迁移队列冒烟（路由）', 'ts-queue-route-');
    const holder = await pool.connect();
    const prober = await pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query(SQL_INSERT_OUTBOX, [
        'agent_run',
        fixture.runId,
        'agent.run.requested',
        1,
        JSON.stringify({ agent_run_id: fixture.runId, trace_id: fixture.traceId, task_version: 1 }),
        fixture.traceId,
        'pending',
      ]);

      // 路由命中：本运行时负责 assessment_generate。
      const matched = await holder.query(SQL_CLAIM_EVENTS, [
        'agent.run.requested',
        ['assessment_generate'],
        900,
        20,
        'itest-dispatcher',
      ]);
      expect(matched.rows).toHaveLength(1);
      expect(String((matched.rows[0] as { aggregate_id: string }).aggregate_id)).toBe(fixture.runId);
      console.log('  · 路由命中：领取到 1 条事件（assessment_generate）');

      // 关键证明：领取只锁 outbox_events（OF o），因此在另一个事务里仍能锁定同一个 agent_runs 行。
      // 若写成裸 FOR UPDATE，这里会抛 55P03 lock_not_available。
      await prober.query('BEGIN');
      const probe = await prober.query('SELECT id FROM agent.agent_runs WHERE id = $1 FOR UPDATE NOWAIT', [fixture.runId]);
      expect(probe.rows).toHaveLength(1);
      await prober.query('ROLLBACK');
      console.log('  · FOR UPDATE OF o 验证通过：同事务外仍可锁定 agent_runs 行（无 55P03）');

      // 路由未命中：本运行不由其它 run_type 的运行时领取。
      const unmatched = await holder.query(SQL_CLAIM_EVENTS, [
        'agent.run.requested',
        ['plan_generate'],
        900,
        20,
        'itest-dispatcher',
      ]);
      expect(unmatched.rows).toHaveLength(0);

      // 空路由集合等于回滚态：不领取任何事件。
      const disabled = await holder.query(SQL_CLAIM_EVENTS, ['agent.run.requested', [], 900, 20, 'itest-dispatcher']);
      expect(disabled.rows).toHaveLength(0);
      console.log('  · 路由与控制组验证通过：非本运行时与空集合均领取不到');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      prober.release();
      await pool.end();
    }
  }, 120_000);

  it.skipIf(!withModel)('发布到 BullMQ 后由 Worker 消费并完成真实 AgentRun', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const repository = new PgAgentRunRepository(pool);
    const fixture = await createFixture(pool, 'TS 迁移队列冒烟（消费）', 'ts-queue-consume-');
    const queue = createAgentQueue(queueConfig);
    let worker: Worker | null = null;

    try {
      const internalClient = new CoreInternalClient({
        baseUrl: internalBaseUrl as string,
        internalServiceSecret: internalSecret as string,
      });
      const workflows = new AgentWorkflowRegistry();
      workflows.register(
        'assessment_generate',
        createAssessmentGenerateWorkflow({
          internalClient,
          decryptor: ModelCredentialDecryptor.fromEnvironment(),
          // 使用真实的出网审计仓库：写入失败会 fail-closed 拒绝出网。
          gateway: new OpenAiCompatibleModelGateway(
            new SafeModelEgressClient(
              { enabled: true, proxyUrl: null, connectTimeoutMs: 15_000, readTimeoutMs: 120_000, maxResponseBytes: 4 * 1024 * 1024 },
              new PgModelEgressAuditRepository(pool, 30),
            ),
            2,
          ),
          maxToolCalls: readAgentToolMaxCalls(),
          createToolGateway: createLiveTavilyToolGatewayFactory(),
        }),
      );

      worker = createAgentRunWorker(
        queueConfig,
        createAgentRunProcessor({ repository, workflows, maxRetries: queueConfig.maxAttempts }),
      );
      await worker.waitUntilReady();

      const job = await publishAgentRun(
        queue,
        { agentRunId: fixture.runId, traceId: fixture.traceId, taskVersion: 1 },
        queueConfig,
      );
      console.log('  · 已发布任务：jobId=' + String(job.id) + '，队列=' + queueConfig.queueName);

      const status = await waitForTerminalStatus(pool, fixture.runId, 240_000);
      expect(status).toBe('succeeded');

      const runRow = (await pool.query(SQL_SELECT_RUN, [fixture.runId])).rows[0] as Record<string, unknown>;
      expect(Number(runRow.input_tokens)).toBeGreaterThan(0);
      expect(Number(runRow.output_tokens)).toBeGreaterThan(0);
      expect(runRow.actual_model_profile).toBe(fixture.modelId);
      expect(Object.keys(runRow.output_summary_json as Record<string, unknown>).sort()).toEqual([
        'assessment_id',
        'model_id',
        'question_count',
        'recovery_stage',
        'status',
        'tool_call_count',
      ]);
      console.log(
        '  · Worker 已完成：tokens=' + String(runRow.input_tokens) + '/' + String(runRow.output_tokens) +
          '，摘要=' + JSON.stringify(runRow.output_summary_json),
      );

      // 出网审计必须真实落库（fail-closed 前置条件）。
      const auditRows = await pool.query(SQL_SELECT_AUDIT, [fixture.runId]);
      expect(auditRows.rows).toHaveLength(1);
      const audit = auditRows.rows[0] as { decision: string; reason_code: string; host: string; port: number; expires_at: Date };
      expect(audit.decision).toBe('allowed');
      expect(audit.reason_code).toBe('MODEL_EGRESS_POLICY_ALLOWED');
      expect(audit.host.length).toBeGreaterThan(0);
      expect(audit.port).toBe(443);
      expect(audit.expires_at.getTime()).toBeGreaterThan(Date.now());
      console.log('  · 出网审计已落库：decision=' + audit.decision + '，host=' + audit.host + '，过期时间在未来');

      const events = await pool.query(SQL_SELECT_EVENTS, [fixture.runId]);
      expect(events.rows.map((row) => (row as { event_type: string }).event_type)).toEqual([
        'run.started',
        'run.succeeded',
      ]);

      const assessment = (await pool.query(SQL_SELECT_ASSESSMENT, [fixture.runId])).rows[0] as
        | { id: string; item_count: number }
        | undefined;
      expect(assessment?.item_count).toBe(QUESTION_COUNT);
      console.log('  · 题集已落库：assessment=' + String(assessment?.id) + '，题目数=' + String(assessment?.item_count));

      // 队列侧：无失败任务，且同 jobId 不会产生第二个任务。
      expect(await queue.getFailedCount()).toBe(0);
      const duplicate = await publishAgentRun(
        queue,
        { agentRunId: fixture.runId, traceId: fixture.traceId, taskVersion: 1 },
        queueConfig,
      );
      expect(String(duplicate.id)).toBe(fixture.runId);
      console.log('  · 队列校验：失败任务 0，重复发布的 jobId 与 agent_run_id 一致（去重）');

      console.log('  · 清理 SQL：DELETE FROM agent.agent_run_events WHERE agent_run_id = ' + fixture.runId + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + fixture.runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + fixture.goalId + ';');
    } finally {
      if (worker !== null) {
        await worker.close();
      }
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      // 清理本用例写入的审计行，避免污染真实审计表。
      await pool.query(SQL_DELETE_AUDIT, [fixture.runId]).catch(() => undefined);
      await pool.end();
    }
  }, 300_000);
});
