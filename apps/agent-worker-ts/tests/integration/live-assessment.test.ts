/**
 * 真实 assessment_generate 端到端冒烟（会产生真实模型费用并写入真实数据，必须显式开启）。
 *
 * 走的是**生产路径**：命令层 executeAgentRun（领取 → 取消检查 → 路由 → 执行 → 回写），
 * 而不是直接调用工作流；因此同时验证「真实 token 用量写入 agent_runs」这条已确认差异确实落地。
 *
 * 开启方式（全部设置后才会运行）：
 *   AGENT_TS_LIVE_E2E=1
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CORE_INTERNAL_BASE_URL=http://127.0.0.1:3000/internal/v1
 *   INTERNAL_SERVICE_SECRET=<与 Web 相同的内部服务密钥>
 *   CREDENTIAL_ENCRYPTION_KEY / CREDENTIAL_ENCRYPTION_KEY_VERSION
 *
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
import { createAssessmentGenerateWorkflow } from '../../src/workflows/assessment-generate/index.js';
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
const SQL_SELECT_ASSESSMENT = "SELECT a.id, a.status, a.requested_question_count, (SELECT count(*)::int FROM public.assessment_items i WHERE i.assessment_id = a.id) AS item_count FROM public.assessments a WHERE a.generation_metadata->>$2 = $1";
const SQL_COUNT_ASSESSMENTS = "SELECT count(*)::int AS n FROM public.assessments a WHERE a.generation_metadata->>$2 = $1";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_RUN = "SELECT status, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code, started_at, finished_at FROM agent.agent_runs WHERE id = $1";

const QUESTION_COUNT = 10;

describe.skipIf(!enabled)('真实 assessment_generate 端到端（经命令层）', () => {
  it('命令层完成一次真实前测并把真实 token 用量写入运行', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PgAgentRunRepository(pool);
    const runId = crypto.randomUUID();
    const traceId = 'ts-command-smoke-' + new Date().toISOString();
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
        'TypeScript 类型系统入门',
        'TS 迁移命令层冒烟',
        '由 apps/agent-worker-ts 的 live-assessment 用例创建，可安全删除。',
        '验证命令层领取、模型生成、题集持久化、状态与 token 回写',
        1,
        'draft',
        connection.id,
      ]);
      const goalId = String((goalResult.rows[0] as { id: string }).id);

      const inputSummary = {
        topic: 'TypeScript 类型系统入门',
        title: 'TypeScript 类型系统入门',
        description: '面向有 JavaScript 基础的开发者',
        desired_outcome: '能读懂并编写常见的类型标注与泛型',
        overall_experience: '有 JavaScript 基础，未系统使用 TypeScript',
        question_count: QUESTION_COUNT,
        difficulty: 'normal',
        kind: 'diagnostic',
      };

      await pool.query(SQL_INSERT_RUN, [
        runId,
        connection.owner_id,
        'assessment_generate',
        'queued',
        'learning_goal',
        goalId,
        'ts-command-smoke-' + runId,
        traceId,
        'assessment_generate.v1',
        'assessment_generate.input.v1',
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
      workflows.register('assessment_generate', createAssessmentGenerateWorkflow({
        internalClient,
        decryptor,
        gateway,
        maxToolCalls: readAgentToolMaxCalls(),
        reactMaxTurns: readAgentReactMaxTurns().assessmentGenerate,
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

      // 运行状态与真实 token 用量（本用例的核心断言）。
      const finalRun = await pool.query(SQL_SELECT_RUN, [runId]);
      const runRow = finalRun.rows[0] as Record<string, unknown>;
      expect(runRow.status).toBe('succeeded');
      expect(runRow.error_code).toBeNull();
      expect(Number(runRow.input_tokens)).toBeGreaterThan(0);
      expect(Number(runRow.output_tokens)).toBeGreaterThan(0);
      expect(runRow.actual_model_profile).toBe(connection.default_model_id);
      expect(runRow.started_at).not.toBeNull();
      expect(runRow.finished_at).not.toBeNull();

      // 摘要键必须与 Python 一致（恰好 6 个），token 不得污染摘要。
      const outputSummary = runRow.output_summary_json as Record<string, unknown>;
      expect(Object.keys(outputSummary).sort()).toEqual([
        'assessment_id',
        'model_id',
        'question_count',
        'recovery_stage',
        'status',
        'tool_call_count',
      ]);
      console.log(
        '  · 运行已回写：tokens=' + String(runRow.input_tokens) + '/' + String(runRow.output_tokens) +
          '，摘要=' + JSON.stringify(outputSummary),
      );

      // 题集落库验证。
      const persisted = await pool.query(SQL_SELECT_ASSESSMENT, [runId, 'agent_run_id']);
      expect(persisted.rows).toHaveLength(1);
      const assessment = persisted.rows[0] as {
        id: string;
        status: string;
        requested_question_count: number;
        item_count: number;
      };
      expect(assessment.item_count).toBe(QUESTION_COUNT);
      expect(assessment.requested_question_count).toBe(QUESTION_COUNT);
      expect(String(outputSummary.assessment_id)).toBe(assessment.id);
      console.log('  · Web 已落库：assessment=' + assessment.id + '，题目数=' + String(assessment.item_count));

      // 内部接口幂等：再次提交同一运行的结果不得新建题集。
      const placeholderQuestions = Array.from({ length: QUESTION_COUNT }, (_, index) => ({
        prompt: '幂等验证占位题 ' + String(index + 1),
        options: [{ key: 'A', text: '选项 A' }, { key: 'B', text: '选项 B' }],
        answer_key: 'A',
        explanation: '占位解析。',
        skill_tags: [],
        max_score: 1,
      }));
      const again = await internalClient.persistAssessment(runId, {
        kind: 'diagnostic',
        question_count: QUESTION_COUNT,
        difficulty: 'normal',
        plan_id: null,
        schema_version: 'assessment.single_choice.v1',
        questions: placeholderQuestions,
      });
      expect(String(again.assessment_id)).toBe(assessment.id);
      const counted = await pool.query(SQL_COUNT_ASSESSMENTS, [runId, 'agent_run_id']);
      expect((counted.rows[0] as { n: number }).n).toBe(1);
      console.log('  · 幂等验证：重复提交后题集仍为 1 份（assessment_id 相同）');

      // 事件序列与重复投递幂等。
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

      console.log('  · 清理 SQL：DELETE FROM public.assessment_items WHERE assessment_id = ' + assessment.id + ';');
      console.log('  · 清理 SQL：DELETE FROM public.assessments WHERE id = ' + assessment.id + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_run_events WHERE agent_run_id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + goalId + ';');
    } finally {
      await pool.end();
    }
  }, 300_000);
});
