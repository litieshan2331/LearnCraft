/**
 * 真实 card_content_generate 端到端冒烟（会产生真实模型费用并写入真实数据，必须显式开启）。
 *
 * 走的是**生产路径**：命令层 executeAgentRun（领取 → 取消检查 → 路由 → 执行 → 回写），
 * 覆盖「取默认模型连接 → 解密凭据 → 生成节点知识文档 → 规范化/修复/兜底 → 经 Web 落库」整条链路，
 * 以及「真实 token 用量写入 agent_runs」这条已确认差异。
 *
 * 开启方式（全部设置后才会运行，与其他 live 用例相同）：
 *   AGENT_TS_LIVE_E2E=1
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CORE_INTERNAL_BASE_URL=http://127.0.0.1:3000/internal/v1
 *   INTERNAL_SERVICE_SECRET=<与 Web 相同的内部服务密钥>
 *   CREDENTIAL_ENCRYPTION_KEY / CREDENTIAL_ENCRYPTION_KEY_VERSION
 *
 * 夹具链：learning_goal → learning_plan → plan_node → agent_run（target 指向该节点）。
 * 用例不会自动删除夹具，结束时会打印清理 SQL。
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
import { createCardContentGenerateWorkflow } from '../../src/workflows/card-content-generate/index.js';
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
const SQL_INSERT_RUN = "INSERT INTO agent.agent_runs (id, owner_id, run_type, status, target_type, target_id, idempotency_key, trace_id, graph_version, input_schema_version, requested_model_profile, input_summary_json, goal_id, model_connection_id, requested_model_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id";
const SQL_SELECT_CONNECTION = "SELECT id, owner_id, default_model_id FROM public.user_model_connections WHERE status = $1 AND is_default = true ORDER BY created_at LIMIT 1";
const SQL_SELECT_CONTENT = "SELECT c.id, c.status, c.version, c.schema_version, c.public_content_json, c.runner_spec_json, c.generation_metadata, (c.plan_node_id::text) AS plan_node_id FROM public.card_contents c WHERE c.generation_metadata->>$2 = $1";
const SQL_SELECT_NODE_STATUS = "SELECT content_status FROM public.plan_nodes WHERE id = $1";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_RUN = "SELECT status, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code, started_at, finished_at FROM agent.agent_runs WHERE id = $1";

describe.skipIf(!enabled)('真实 card_content_generate 端到端（经命令层）', () => {
  it('命令层完成一次真实节点内容生成并落库', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PgAgentRunRepository(pool);
    const runId = crypto.randomUUID();
    const traceId = 'ts-card-smoke-' + new Date().toISOString();
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
        'TS 迁移节点内容冒烟',
        '由 apps/agent-worker-ts 的 live-card-content 用例创建，可安全删除。',
        '理解函数定义、参数传递与返回值',
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
        'TS 迁移节点内容冒烟路线',
        '由 live-card-content 用例创建。',
        'active',
        'learning_plan.v1',
      ]);
      const planId = String((planResult.rows[0] as { id: string }).id);

      const nodeResult = await pool.query(SQL_INSERT_NODE, [
        connection.owner_id,
        planId,
        'function_params',
        '理解位置参数、关键字参数与默认值。',
        1,
        'core',
        '函数参数与返回值',
        '能定义带参数与默认值的函数，并正确返回结果',
        2,
        30,
        JSON.stringify({ criteria: ['能写出发起调用的函数'] }),
        'available',
        'not_requested',
      ]);
      const planNodeId = String((nodeResult.rows[0] as { id: string }).id);

      const inputSummary = {
        agent_role: 'node_tutor',
        logical_session_key: 'node:' + planNodeId,
        goal: { topic: 'Python 函数与参数', desired_outcome: '理解函数定义、参数传递与返回值' },
        learner_profile: { profile_version: 1, current_level: 'beginner', weekly_minutes: 300 },
        learning_plan: { id: planId, title: 'TS 迁移节点内容冒烟路线', summary: '按章节组织的学习路线。' },
        plan_node: {
          id: planNodeId,
          node_key: 'function_params',
          title: '函数参数与返回值',
          node_brief: '理解位置参数、关键字参数与默认值。',
          learning_objective: '能定义带参数与默认值的函数，并正确返回结果',
          completion_criteria: ['能写出发起调用的函数'],
        },
      };

      await pool.query(SQL_INSERT_RUN, [
        runId,
        connection.owner_id,
        'card_content_generate',
        'queued',
        'plan_node',
        planNodeId,
        'ts-card-smoke-' + runId,
        traceId,
        'card_content_generate.v1',
        'card_content_generate.input.v1',
        'account_default_openai_compatible',
        JSON.stringify(inputSummary),
        goalId,
        connection.id,
        connection.default_model_id,
      ]);
      console.log(
        '  · 夹具：goal=' + goalId + '，plan=' + planId + '，node=' + planNodeId +
          '，agent_run=' + runId + '，模型=' + connection.default_model_id,
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
      workflows.register('card_content_generate', createCardContentGenerateWorkflow({
        internalClient,
        decryptor,
        gateway,
        maxToolCalls: readAgentToolMaxCalls(),
        reactMaxTurns: readAgentReactMaxTurns().cardContentGenerate,
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

      // 摘要键必须与 Python 一致（恰好 4 个），token 不得污染摘要。
      const outputSummary = runRow.output_summary_json as Record<string, unknown>;
      expect(Object.keys(outputSummary).sort()).toEqual([
        'card_content_id',
        'model_id',
        'plan_node_id',
        'tool_call_count',
      ]);
      expect(String(outputSummary.plan_node_id)).toBe(planNodeId);
      console.log(
        '  · 运行已回写：tokens=' + String(runRow.input_tokens) + '/' + String(runRow.output_tokens) +
          '，摘要=' + JSON.stringify(outputSummary),
      );

      const persisted = await pool.query(SQL_SELECT_CONTENT, [runId, 'agent_run_id']);
      expect(persisted.rows).toHaveLength(1);
      const card = persisted.rows[0] as {
        id: string;
        status: string;
        version: number;
        schema_version: string;
        public_content_json: Record<string, unknown>;
        runner_spec_json: Record<string, unknown>;
        generation_metadata: Record<string, unknown>;
        plan_node_id: string;
      };
      expect(card.status).toBe('ready');
      expect(card.version).toBe(1);
      expect(card.schema_version).toBe('card_content.v2');
      expect(card.plan_node_id).toBe(planNodeId);
      expect(String(outputSummary.card_content_id)).toBe(card.id);

      const workedExample = card.public_content_json.worked_example as Record<string, unknown>;
      const pitfalls = card.public_content_json.pitfalls_debug as Array<Record<string, unknown>>;
      const memory = card.runner_spec_json.teaching_memory as Record<string, unknown>;
      expect(String(card.public_content_json.foundation).length).toBeGreaterThan(50);
      expect(Object.keys(workedExample).sort()).toEqual([
        'call_sequence', 'entry_file', 'expected_output', 'explanation', 'files',
      ]);
      const files = workedExample.files as Array<Record<string, unknown>>;
      expect(files.length).toBeGreaterThanOrEqual(1);
      const entryFile = files.find((file) => file.path === workedExample.entry_file);
      expect(entryFile).toBeDefined();
      for (const file of files) {
        expect(Object.keys(file).sort()).toEqual(['content', 'language', 'path', 'role']);
      }
      expect(typeof workedExample.expected_output).toBe('string');
      expect(pitfalls.length).toBeGreaterThanOrEqual(1);
      for (const pitfall of pitfalls) {
        expect(Object.keys(pitfall).sort()).toEqual(['cause', 'fix', 'title']);
      }
      expect((memory.key_concepts as string[]).length).toBeGreaterThanOrEqual(1);
      expect((memory.assessment_targets as string[]).length).toBeGreaterThanOrEqual(1);
      expect(card.generation_metadata).toMatchObject({
        model_id: connection.default_model_id,
        tool_call_count: 0,
        logical_session_key: 'node:' + planNodeId,
      });
      console.log(
        '  · Web 已落库：card_content=' + card.id + '，foundation=' + String(card.public_content_json.foundation).length +
          ' 字，误区=' + String(pitfalls.length) + ' 项，key_concepts=' + String((memory.key_concepts as string[]).length) + ' 项',
      );
      console.log(
        '  · 入口文件 ' + String(entryFile?.path) + ' 首行：' + String(entryFile?.content ?? '').split('\n')[0],
      );
      console.log('  · 元数据=' + JSON.stringify(card.generation_metadata));

      // Web 在写入内容后把节点内容状态置为 ready（与 Python 路径完全一致）。
      const nodeStatus = await pool.query(SQL_SELECT_NODE_STATUS, [planNodeId]);
      expect((nodeStatus.rows[0] as { content_status: string }).content_status).toBe('ready');

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
      console.log('  · 清理 SQL：DELETE FROM public.card_contents WHERE id = ' + card.id + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.plan_nodes WHERE id = ' + planNodeId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_plans WHERE id = ' + planId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + goalId + ';');
    } finally {
      await pool.end();
    }
  }, 300_000);
});
