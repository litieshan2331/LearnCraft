/**
 * 真实 plan_generate 端到端冒烟（会产生真实模型费用并写入真实数据，必须显式开启）。
 *
 * 走的是**生产路径**：命令层 executeAgentRun（领取 → 取消检查 → 路由 → 执行 → 回写），
 * 覆盖「取默认模型连接 → 解密凭据 → 生成路线 → 校验/修复/兜底 → 经 Web 落库」整条链路，
 * 以及「真实 token 用量写入 agent_runs」这条已确认差异。
 *
 * 开启方式（全部设置后才会运行，与 live-assessment / live-posttest 相同）：
 *   AGENT_TS_LIVE_E2E=1
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CORE_INTERNAL_BASE_URL=http://127.0.0.1:3000/internal/v1
 *   INTERNAL_SERVICE_SECRET=<与 Web 相同的内部服务密钥>
 *   CREDENTIAL_ENCRYPTION_KEY / CREDENTIAL_ENCRYPTION_KEY_VERSION
 *
 * 夹具链：learning_goal → agent_run（target 指向该 goal）。用例不会自动删除夹具，结束时打印清理 SQL。
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { CoreInternalClient } from '../../src/acl/core-internal-client.js';
import { readAgentReactMaxTurns, readAgentToolMaxCalls } from '../../src/bootstrap/config.js';
import { executeAgentRun } from '../../src/application/commands/execute-agent-run.js';
import { AgentWorkflowRegistry } from '../../src/application/services/agent-workflow-registry.js';
import { PgAgentRunRepository } from '../../src/infrastructure/database/agent-run-repository.js';
import { ModelCredentialDecryptor } from '../../src/infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../../src/infrastructure/llm/model-gateway.js';
import {
  SafeModelEgressClient,
  type ModelEgressAuditEntry,
} from '../../src/infrastructure/llm/safe-egress-client.js';
import { createPlanGenerateWorkflow } from '../../src/workflows/plan-generate/index.js';
import { createLiveTavilyToolGatewayFactory } from '../helpers/live-tavily-gateway.js';

const { Pool } = pg;

const databaseUrl = process.env.AGENT_TS_TEST_DATABASE_URL;
const internalBaseUrl = process.env.CORE_INTERNAL_BASE_URL;
const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
const enabled =
  process.env.AGENT_TS_LIVE_E2E === '1'
  && typeof databaseUrl === 'string' && databaseUrl.length > 0
  && typeof internalBaseUrl === 'string' && internalBaseUrl.length > 0
  && typeof internalSecret === 'string' && internalSecret.length > 0;

const SQL_INSERT_GOAL = "INSERT INTO public.learning_goals (owner_id, topic, title, description, desired_outcome, profile_version, status, model_connection_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id";
const SQL_INSERT_RUN = "INSERT INTO agent.agent_runs (id, owner_id, run_type, status, target_type, target_id, idempotency_key, trace_id, graph_version, input_schema_version, requested_model_profile, input_summary_json, goal_id, model_connection_id, requested_model_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id";
const SQL_SELECT_CONNECTION = "SELECT id, owner_id, default_model_id FROM public.user_model_connections WHERE status = $1 AND is_default = true ORDER BY created_at LIMIT 1";
const SQL_SELECT_PLAN = "SELECT p.id, p.status, p.version, p.title, p.summary, p.generation_metadata, (SELECT count(*)::int FROM public.plan_nodes n WHERE n.plan_id = p.id) AS node_count FROM public.learning_plans p WHERE p.generation_metadata->>$2 = $1";
// 依赖关系存放在关联表 plan_node_prerequisites 中，这里按 node_key 聚合回读。
const SQL_SELECT_NODES = "SELECT n.node_key, n.ordinal, n.difficulty, n.estimated_minutes, COALESCE(array_agg(p.node_key ORDER BY p.node_key) FILTER (WHERE p.node_key IS NOT NULL), '{}') AS prerequisite_node_keys FROM public.plan_nodes n LEFT JOIN public.plan_node_prerequisites pp ON pp.node_id = n.id LEFT JOIN public.plan_nodes p ON p.id = pp.prerequisite_node_id WHERE n.plan_id = $1 GROUP BY n.id, n.node_key, n.ordinal, n.difficulty, n.estimated_minutes ORDER BY n.ordinal";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_RUN = "SELECT status, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code, started_at, finished_at FROM agent.agent_runs WHERE id = $1";

describe.skipIf(!enabled)('真实 plan_generate 端到端（经命令层）', () => {
  it('命令层完成一次真实学习路线生成并落库', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PgAgentRunRepository(pool);
    const runId = crypto.randomUUID();
    const traceId = 'ts-plan-smoke-' + new Date().toISOString();
    const auditEntries: ModelEgressAuditEntry[] = [];

    try {
      const connectionResult = await pool.query(SQL_SELECT_CONNECTION, ['active']);
      const connection = connectionResult.rows[0] as { id: string; owner_id: string; default_model_id: string } | undefined;
      expect(connection).toBeDefined();
      if (connection === undefined) {
        return;
      }

      const goalResult = await pool.query(SQL_INSERT_GOAL, [
        connection.owner_id,
        'Python 函数与类',
        'TS 迁移路线冒烟',
        '由 apps/agent-worker-ts 的 live-plan 用例创建，可安全删除。',
        '能用函数与类组织一个可运行的小项目',
        1,
        'draft',
        connection.id,
      ]);
      const goalId = String((goalResult.rows[0] as { id: string }).id);

      const inputSummary = {
        goal: {
          id: goalId,
          topic: 'Python 函数与类',
          title: 'TS 迁移路线冒烟',
          description: '由 live-plan 用例创建的学习目标。',
          desired_outcome: '能用函数与类组织一个可运行的小项目',
        },
        learner_profile: {
          profile_version: 1,
          current_level: 'beginner',
          weekly_minutes: 300,
          background_summary: '有少量脚本经验，未系统学习函数与类。',
        },
        diagnostic_assessment: {
          assessment_id: 'live-plan-fixture',
          score_percent: 42.5,
          mastery_summary: { functions: 'weak', classes: 'unknown' },
        },
      };

      await pool.query(SQL_INSERT_RUN, [
        runId,
        connection.owner_id,
        'plan_generate',
        'queued',
        'learning_goal',
        goalId,
        'ts-plan-smoke-' + runId,
        traceId,
        'plan_generate.v1',
        'plan_generate.input.v1',
        'account_default_openai_compatible',
        JSON.stringify(inputSummary),
        goalId,
        connection.id,
        connection.default_model_id,
      ]);
      console.log('  · 夹具：goal=' + goalId + '，agent_run=' + runId + '，模型=' + connection.default_model_id);

      const internalClient = new CoreInternalClient({
        baseUrl: internalBaseUrl as string,
        internalServiceSecret: internalSecret as string,
      });
      const decryptor = ModelCredentialDecryptor.fromEnvironment();
      const egress = new SafeModelEgressClient(
        { enabled: true, proxyUrl: null, connectTimeoutMs: 15_000, readTimeoutMs: 120_000, maxResponseBytes: 4 * 1024 * 1024 },
        { record: async (entry) => void auditEntries.push(entry) },
      );
      const gateway = new OpenAiCompatibleModelGateway(egress, 2);

      const workflows = new AgentWorkflowRegistry();
      workflows.register('plan_generate', createPlanGenerateWorkflow({
        internalClient,
        decryptor,
        gateway,
        maxToolCalls: readAgentToolMaxCalls(),
        reactMaxTurns: readAgentReactMaxTurns().planGenerate,
        createToolGateway: createLiveTavilyToolGatewayFactory(),
      }));
      console.log('  · 已注册工作流：' + JSON.stringify(workflows.registeredRunTypes()));

      const started = Date.now();
      const outcome = await executeAgentRun({
        task: { agentRunId: runId, traceId, taskVersion: 1 },
        retryCount: 0,
        repository,
        workflows,
      });
      const elapsed = Date.now() - started;
      expect(outcome).toEqual({ status: 'succeeded', runId });
      console.log('  · 命令层完成：耗时=' + String(elapsed) + 'ms，outcome=' + JSON.stringify(outcome));

      const finalRun = await pool.query(SQL_SELECT_RUN, [runId]);
      const runRow = finalRun.rows[0] as Record<string, unknown>;
      expect(runRow.status).toBe('succeeded');
      expect(runRow.error_code).toBeNull();
      expect(Number(runRow.input_tokens)).toBeGreaterThan(0);
      expect(Number(runRow.output_tokens)).toBeGreaterThan(0);
      expect(runRow.actual_model_profile).toBe(connection.default_model_id);

      // 摘要键必须与 Python 一致（恰好 6 个），token 不得污染摘要。
      const outputSummary = runRow.output_summary_json as Record<string, unknown>;
      expect(Object.keys(outputSummary).sort()).toEqual([
        'generation_path',
        'learning_plan_id',
        'model_id',
        'node_count',
        'repair_attempts',
        'tool_call_count',
      ]);
      expect(['model_knowledge', 'model_with_tavily', 'tavily_recovery'])
        .toContain(String(outputSummary.generation_path));
      console.log(
        '  · 运行已回写：tokens=' + String(runRow.input_tokens) + '/' + String(runRow.output_tokens) +
          '，摘要=' + JSON.stringify(outputSummary),
      );

      const persisted = await pool.query(SQL_SELECT_PLAN, [runId, 'agent_run_id']);
      expect(persisted.rows).toHaveLength(1);
      const plan = persisted.rows[0] as {
        id: string;
        status: string;
        version: number;
        title: string;
        summary: string;
        generation_metadata: Record<string, unknown>;
        node_count: number;
      };
      expect(plan.status).toBe('active');
      expect(plan.version).toBe(1);
      expect(plan.node_count).toBe(Number(outputSummary.node_count));
      expect(plan.node_count).toBeGreaterThanOrEqual(6);
      expect(plan.node_count).toBeLessThanOrEqual(12);
      expect(String(outputSummary.learning_plan_id)).toBe(plan.id);
      expect(plan.generation_metadata).toMatchObject({
        tool_call_count: 0,
        model_id: connection.default_model_id,
      });
      console.log(
        '  · Web 已落库：plan=' + plan.id + '，章节数=' + String(plan.node_count) +
          '，标题=' + plan.title + '，元数据=' + JSON.stringify(plan.generation_metadata),
      );

      // 章节顺序与依赖结构：ordinal 必须是 1..n，且依赖指向已存在的 node_key。
      const nodes = (await pool.query(SQL_SELECT_NODES, [plan.id])).rows as Array<{
        node_key: string;
        ordinal: number;
        difficulty: number;
        estimated_minutes: number;
        prerequisite_node_keys: string[];
      }>;
      expect(nodes.map((node) => node.ordinal)).toEqual(
        Array.from({ length: nodes.length }, (_, index) => index + 1),
      );
      const keys = new Set(nodes.map((node) => node.node_key));
      for (const node of nodes) {
        expect(node.difficulty).toBeGreaterThanOrEqual(1);
        expect(node.difficulty).toBeLessThanOrEqual(5);
        expect(node.estimated_minutes).toBeGreaterThanOrEqual(5);
        for (const prerequisite of node.prerequisite_node_keys ?? []) {
          expect(keys.has(prerequisite)).toBe(true);
          expect(prerequisite).not.toBe(node.node_key);
        }
      }
      console.log(
        '  · 章节结构：' + JSON.stringify(nodes.map((node) => ({
          key: node.node_key,
          ordinal: node.ordinal,
          minutes: node.estimated_minutes,
          prerequisites: node.prerequisite_node_keys,
        }))),
      );

      const events = await pool.query(SQL_SELECT_EVENTS, [runId]);
      expect(events.rows.map((row) => (row as { event_type: string }).event_type)).toEqual([
        'run.started',
        'run.succeeded',
      ]);
      const secondOutcome = await executeAgentRun({
        task: { agentRunId: runId, traceId, taskVersion: 1 },
        retryCount: 1,
        repository,
        workflows,
      });
      expect(secondOutcome).toEqual({ status: 'skipped', reason: 'already_finished' });
      const eventsAfter = await pool.query(SQL_SELECT_EVENTS, [runId]);
      expect(eventsAfter.rows).toHaveLength(2);
      console.log('  · 重复投递验证：shouldExecute=false，事件数仍为 2');
      console.log('  · 出网审计决策：' + JSON.stringify(auditEntries.map((entry) => entry.decision)));

      console.log('  · 清理 SQL：DELETE FROM agent.agent_run_events WHERE agent_run_id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.plan_nodes WHERE plan_id = ' + plan.id + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_plans WHERE id = ' + plan.id + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + goalId + ';');
    } finally {
      await pool.end();
    }
  }, 300_000);
});
