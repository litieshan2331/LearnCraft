/**
 * 真实 posttest_generate 端到端冒烟（会产生真实模型费用并写入真实数据，必须显式开启）。
 *
 * 走的是**生产路径**：命令层 executeAgentRun（领取 → 取消检查 → 路由 → 执行 → 回写），
 * 因此同时覆盖「读固定节点内容 → 取默认模型连接 → 解密凭据 → 生成题集 → 回写」整条链路，
 * 以及「真实 token 用量写入 agent_runs」这条已确认差异。
 *
 * 开启方式（全部设置后才会运行，与 live-assessment 相同）：
 *   AGENT_TS_LIVE_E2E=1
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CORE_INTERNAL_BASE_URL=http://127.0.0.1:3000/internal/v1
 *   INTERNAL_SERVICE_SECRET=<与 Web 相同的内部服务密钥>
 *   CREDENTIAL_ENCRYPTION_KEY / CREDENTIAL_ENCRYPTION_KEY_VERSION
 *
 * 夹具链：learning_goal → learning_plan → plan_node → card_content → agent_run。
 * 用例不会自动删除夹具，结束时会打印清理 SQL。
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { CoreInternalClient } from '../../src/acl/core-internal-client.js';
import { readAgentToolMaxCalls } from '../../src/bootstrap/config.js';
import { executeAgentRun } from '../../src/application/commands/execute-agent-run.js';
import { AgentWorkflowRegistry } from '../../src/application/services/agent-workflow-registry.js';
import { PgAgentRunRepository } from '../../src/infrastructure/database/agent-run-repository.js';
import { ModelCredentialDecryptor } from '../../src/infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../../src/infrastructure/llm/model-gateway.js';
import {
  SafeModelEgressClient,
  type ModelEgressAuditEntry,
} from '../../src/infrastructure/llm/safe-egress-client.js';
import { createPosttestGenerateWorkflow } from '../../src/workflows/posttest-generate.js';
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
const SQL_INSERT_PLAN = "INSERT INTO public.learning_plans (owner_id, goal_id, profile_version, input_snapshot_json, version, title, summary, status, schema_version) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id";
const SQL_INSERT_NODE = "INSERT INTO public.plan_nodes (owner_id, plan_id, node_key, node_brief, ordinal, node_kind, title, learning_objective, difficulty, estimated_minutes, completion_criteria, status, content_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13) RETURNING id";
const SQL_INSERT_CARD = "INSERT INTO public.card_contents (owner_id, plan_node_id, version, status, schema_version, public_content_json, runner_spec_json, generation_metadata, generated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now()) RETURNING id";
const SQL_INSERT_RUN = "INSERT INTO agent.agent_runs (id, owner_id, run_type, status, target_type, target_id, idempotency_key, trace_id, graph_version, input_schema_version, requested_model_profile, input_summary_json, goal_id, model_connection_id, requested_model_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id";
const SQL_SELECT_CONNECTION = "SELECT id, owner_id, default_model_id FROM public.user_model_connections WHERE status = $1 AND is_default = true ORDER BY created_at LIMIT 1";
const SQL_SELECT_ASSESSMENT = "SELECT a.id, a.kind, a.status, a.plan_node_id, a.source_card_content_id, a.requested_question_count, a.generation_metadata, (SELECT count(*)::int FROM public.assessment_items i WHERE i.assessment_id = a.id) AS item_count FROM public.assessments a WHERE a.generation_metadata->>$2 = $1";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_RUN = "SELECT status, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code, started_at, finished_at FROM agent.agent_runs WHERE id = $1";

const QUESTION_COUNT = 5;

describe.skipIf(!enabled)('真实 posttest_generate 端到端（经命令层）', () => {
  it('命令层基于固定节点内容完成一次真实后测并落库', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PgAgentRunRepository(pool);
    const runId = crypto.randomUUID();
    const traceId = 'ts-posttest-smoke-' + new Date().toISOString();
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
        'Python 函数与参数',
        'TS 迁移后测冒烟',
        '由 apps/agent-worker-ts 的 live-posttest 用例创建，可安全删除。',
        '验证命令层读取固定节点内容并生成后测',
        1,
        'draft',
        connection.id,
      ]);
      const goalId = String((goalResult.rows[0] as { id: string }).id);

      const planResult = await pool.query(SQL_INSERT_PLAN, [
        connection.owner_id,
        goalId,
        1,
        JSON.stringify({ topic: 'Python 函数与参数' }),
        1,
        'TS 迁移后测冒烟路线',
        '由 live-posttest 用例创建。',
        'active',
        'learning_plan.v1',
      ]);
      const planId = String((planResult.rows[0] as { id: string }).id);

      const nodeResult = await pool.query(SQL_INSERT_NODE, [
        connection.owner_id,
        planId,
        'node-1',
        '理解函数定义、参数与返回值。',
        1,
        'core',
        '函数与参数',
        '能定义带参数的函数并正确返回结果',
        2,
        30,
        JSON.stringify({ criteria: ['能写出发起调用的函数'] }),
        'available',
        'ready',
      ]);
      const planNodeId = String((nodeResult.rows[0] as { id: string }).id);

      const cardResult = await pool.query(SQL_INSERT_CARD, [
        connection.owner_id,
        planNodeId,
        1,
        'ready',
        'card_content.v1',
        JSON.stringify({
          foundation: 'Python 使用 def 定义函数，参数写在括号内，return 返回结果；没有 return 时返回 None。',
          worked_example: { title: '求和函数', code: 'def add(a, b):\n    return a + b' },
          pitfalls_debug: [{ title: '忘记写 return', cause: '函数没有返回值时会返回 None。', fix: '在函数体末尾补上 return 语句。' }],
        }),
        JSON.stringify({
          teaching_memory: {
            summary: '函数由 def、参数列表、函数体与返回值组成。',
            key_points: ['参数是输入', 'return 是输出', '无 return 返回 None'],
          },
        }),
        JSON.stringify({ source: 'live-posttest-fixture' }),
      ]);
      const cardContentId = String((cardResult.rows[0] as { id: string }).id);

      const inputSummary = {
        topic: 'Python 函数与参数',
        question_count: QUESTION_COUNT,
        difficulty: 'normal',
        kind: 'post_test',
        plan_node_id: planNodeId,
        source_card_content_id: cardContentId,
      };

      await pool.query(SQL_INSERT_RUN, [
        runId,
        connection.owner_id,
        'posttest_generate',
        'queued',
        'plan_node',
        planNodeId,
        'ts-posttest-smoke-' + runId,
        traceId,
        'posttest_generate.v1',
        'posttest_generate.input.v1',
        'account_default_openai_compatible',
        JSON.stringify(inputSummary),
        goalId,
        connection.id,
        connection.default_model_id,
      ]);
      console.log(
        '  · 夹具：goal=' + goalId + '，plan=' + planId + '，node=' + planNodeId +
          '，card_content=' + cardContentId + '，agent_run=' + runId + '，模型=' + connection.default_model_id,
      );

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
      workflows.register('posttest_generate', createPosttestGenerateWorkflow({
        internalClient,
        decryptor,
        gateway,
        maxToolCalls: readAgentToolMaxCalls(),
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

      // 摘要键必须与 Python 一致（恰好 5 个，后测没有 status），token 不得污染摘要。
      const outputSummary = runRow.output_summary_json as Record<string, unknown>;
      expect(Object.keys(outputSummary).sort()).toEqual([
        'assessment_id',
        'model_id',
        'question_count',
        'recovery_stage',
        'tool_call_count',
      ]);
      console.log(
        '  · 运行已回写：tokens=' + String(runRow.input_tokens) + '/' + String(runRow.output_tokens) +
          '，摘要=' + JSON.stringify(outputSummary),
      );

      const persisted = await pool.query(SQL_SELECT_ASSESSMENT, [runId, 'agent_run_id']);
      expect(persisted.rows).toHaveLength(1);
      const assessment = persisted.rows[0] as {
        id: string;
        kind: string;
        status: string;
        plan_node_id: string;
        source_card_content_id: string;
        requested_question_count: number;
        generation_metadata: Record<string, unknown>;
        item_count: number;
      };
      expect(assessment.kind).toBe('post_test');
      expect(assessment.plan_node_id).toBe(planNodeId);
      expect(assessment.source_card_content_id).toBe(cardContentId);
      expect(assessment.item_count).toBe(QUESTION_COUNT);
      expect(assessment.requested_question_count).toBe(QUESTION_COUNT);
      expect(String(outputSummary.assessment_id)).toBe(assessment.id);
      expect(assessment.generation_metadata).toMatchObject({
        source_card_content_id: cardContentId,
        tool_call_count: 0,
        recovery_stage: 'initial',
      });
      console.log(
        '  · Web 已落库：assessment=' + assessment.id + '，kind=' + assessment.kind +
          '，题目数=' + String(assessment.item_count) + '，元数据=' + JSON.stringify(assessment.generation_metadata),
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
      console.log('  · 清理 SQL：DELETE FROM public.assessment_items WHERE assessment_id = ' + assessment.id + ';');
      console.log('  · 清理 SQL：DELETE FROM public.assessments WHERE id = ' + assessment.id + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.card_contents WHERE id = ' + cardContentId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.plan_nodes WHERE id = ' + planNodeId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_plans WHERE id = ' + planId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + goalId + ';');
    } finally {
      await pool.end();
    }
  }, 300_000);
});
