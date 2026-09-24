/**
 * 真实端到端冒烟测试（会产生真实费用并写入真实数据，必须显式开启）。
 *
 * 链路：写入夹具（goal + agent_run）→ Repository.beginExecution 领取并加行锁 → 解密真实凭据
 *       → 受控出网调用真实 Provider（SSE）→ Repository.markSucceeded 回写 → 校验运行状态与事件序列。
 *
 * 开启方式（三项都要设置，否则整个文件跳过）：
 *   AGENT_TS_LIVE_E2E=1                # 显式确认：允许真实模型调用与真实写入
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CREDENTIAL_ENCRYPTION_KEY=<Base64 的 32 字节主密钥>
 *   CREDENTIAL_ENCRYPTION_KEY_VERSION=<密钥版本>
 *
 * 说明：本用例**不会**自行删除夹具，便于人工核对运行记录；文件末尾给出了清理 SQL。
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { PgAgentRunRepository } from '../../src/infrastructure/database/agent-run-repository.js';
import {
  ModelCredentialDecryptor,
  type EncryptedModelCredentialEnvelope,
} from '../../src/infrastructure/llm/credential-decryptor.js';
import { ModelEgressPolicy } from '../../src/infrastructure/llm/egress-policy.js';
import {
  SafeModelEgressClient,
  type ModelEgressAuditEntry,
} from '../../src/infrastructure/llm/safe-egress-client.js';

const { Pool } = pg;

const databaseUrl = process.env.AGENT_TS_TEST_DATABASE_URL;
const enabled =
  process.env.AGENT_TS_LIVE_E2E === '1' && typeof databaseUrl === 'string' && databaseUrl.length > 0;

const SQL_INSERT_GOAL = "INSERT INTO public.learning_goals (owner_id, topic, title, description, desired_outcome, profile_version, status, model_connection_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id";
const SQL_INSERT_RUN = "INSERT INTO agent.agent_runs (id, owner_id, run_type, status, target_type, target_id, idempotency_key, trace_id, graph_version, input_schema_version, requested_model_profile, input_summary_json, goal_id, model_connection_id, requested_model_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id";
const SQL_SELECT_RUN = "SELECT status, retry_count, started_at, finished_at, output_summary_json, input_tokens, output_tokens, actual_model_profile, error_code, error_summary, updated_at FROM agent.agent_runs WHERE id = $1";
const SQL_SELECT_EVENTS = "SELECT sequence_no, event_type, payload_json FROM agent.agent_run_events WHERE agent_run_id = $1 ORDER BY sequence_no";
const SQL_SELECT_CONNECTION = "SELECT id, owner_id, base_url, default_model_id, encrypted_api_key, api_key_iv, api_key_auth_tag, encryption_key_version FROM public.user_model_connections WHERE id = $1";
const SQL_SELECT_DEFAULT_CONNECTION = "SELECT id, owner_id, base_url, default_model_id, encrypted_api_key, api_key_iv, api_key_auth_tag, encryption_key_version FROM public.user_model_connections WHERE status = $1 AND is_default = true ORDER BY created_at LIMIT 1";

interface ConnectionRow {
  id: string;
  owner_id: string;
  base_url: string;
  default_model_id: string;
  encrypted_api_key: string;
  api_key_iv: string;
  api_key_auth_tag: string;
  encryption_key_version: string;
}

/** 从 SSE 事件流里边读边提取正文与用量；只做最小提取，不保存原始事件。 */
async function extractCompletion(
  events: AsyncIterable<unknown>,
): Promise<{ text: string; inputTokens: number; outputTokens: number; eventCount: number }> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let eventCount = 0;
  for await (const event of events) {
    eventCount += 1;
    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    const usage = record.usage;
    if (typeof usage === 'object' && usage !== null) {
      const counters = usage as Record<string, unknown>;
      if (typeof counters.prompt_tokens === 'number') {
        inputTokens = counters.prompt_tokens;
      }
      if (typeof counters.completion_tokens === 'number') {
        outputTokens = counters.completion_tokens;
      }
    }
    const choices = record.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      continue;
    }
    const first = choices[0];
    if (typeof first !== 'object' || first === null) {
      continue;
    }
    const delta = (first as Record<string, unknown>).delta;
    if (typeof delta !== 'object' || delta === null) {
      continue;
    }
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === 'string') {
      text += content;
    }
  }
  return { text, inputTokens, outputTokens, eventCount };
}

describe.skipIf(!enabled)('真实端到端：领取 → 解密 → 调用 Provider → 回写', () => {
  it('完成一次真实 AgentRun 并写入成功状态与事件', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PgAgentRunRepository(pool);
    const runId = crypto.randomUUID();
    const traceId = 'ts-e2e-smoke-' + new Date().toISOString();
    const auditEntries: ModelEgressAuditEntry[] = [];

    try {
      // 1) 选择真实的模型连接（优先目标用户的默认连接）。
      // 不绑定具体用户：取任意一条可用的账户默认连接，保证用例在不同环境可移植。
      const connectionResult = await pool.query(SQL_SELECT_DEFAULT_CONNECTION, ['active']);
      const connection = (connectionResult.rows[0] ?? null) as ConnectionRow | null;
      expect(connection).not.toBeNull();
      if (connection === null) {
        return;
      }
      console.log('  · 使用真实连接 ' + connection.id + '，Provider=' + connection.base_url + '，模型=' + connection.default_model_id);

      // 2) 写入夹具：学习目标 + 处于 queued 的 AgentRun。
      const goalResult = await pool.query(SQL_INSERT_GOAL, [
        connection.owner_id,
        'TypeScript 迁移冒烟',
        'Agent 侧 TS 迁移端到端冒烟',
        '由 apps/agent-worker-ts 的 live-e2e 用例创建，可安全删除。',
        '验证领取、出网与回写链路',
        1,
        'draft',
        connection.id,
      ]);
      const goalId = String((goalResult.rows[0] as { id: string }).id);

      await pool.query(SQL_INSERT_RUN, [
        runId,
        connection.owner_id,
        'assessment_generate',
        'queued',
        'learning_goal',
        goalId,
        'ts-e2e-smoke-' + runId,
        traceId,
        'assessment_generate.v1',
        'assessment_generate.input.v1',
        'account_default_openai_compatible',
        JSON.stringify({ topic: 'TypeScript 迁移冒烟', question_count: 10 }),
        goalId,
        connection.id,
        connection.default_model_id,
      ]);
      console.log('  · 夹具已写入：goal=' + goalId + '，agent_run=' + runId);

      // 3) 领取：应由 queued 推进到 running 并追加 run.started。
      const state = await repository.beginExecution({ runId, traceId, retryCount: 0 });
      expect(state.shouldExecute).toBe(true);
      expect(state).toMatchObject({ runId, status: 'running', runType: 'assessment_generate' });
      await expect(repository.isCancelled(runId)).resolves.toBe(false);

      const afterClaim = await pool.query(SQL_SELECT_EVENTS, [runId]);
      expect(afterClaim.rows.map((row) => (row as { event_type: string }).event_type)).toEqual(['run.started']);
      console.log('  · 领取成功：状态=running，事件数=' + String(afterClaim.rows.length));

      // 4) 解密真实凭据。
      const decryptor = ModelCredentialDecryptor.fromEnvironment();
      const envelope: EncryptedModelCredentialEnvelope = {
        ciphertext_base64: connection.encrypted_api_key,
        iv_base64: connection.api_key_iv,
        auth_tag_base64: connection.api_key_auth_tag,
        encryption_key_version: connection.encryption_key_version,
      };
      const apiKey = decryptor.decrypt(connection.owner_id, envelope);
      console.log('  · 凭据解密成功：明文长度=' + String(apiKey.length) + '，前缀=' + apiKey.slice(0, 3) + '***');

      // 5) 受控出网调用真实 Provider（SSE）。
      const egress = new SafeModelEgressClient(
        {
          enabled: true,
          proxyUrl: null,
          connectTimeoutMs: 15_000,
          readTimeoutMs: 90_000,
          maxResponseBytes: 4 * 1024 * 1024,
        },
        { record: async (entry) => void auditEntries.push(entry) },
        new ModelEgressPolicy(),
      );

      const started = Date.now();
      const response = await egress.postOpenAiCompatibleSse({
        ownerId: connection.owner_id,
        modelConnectionId: connection.id,
        agentRunId: runId,
        baseUrl: connection.base_url,
        apiKey,
        endpointSegments: ['chat', 'completions'],
        payload: {
          model: connection.default_model_id,
          messages: [{ role: 'user', content: '请只回复两个字：收到' }],
          stream: true,
          stream_options: { include_usage: true },
        },
      });
      const completion = await extractCompletion(response.events);
      expect(completion.text.length).toBeGreaterThan(0);
      console.log(
        '  · Provider 返回：状态=' + String(response.statusCode) + '，事件数=' + String(completion.eventCount) +
          '，耗时=' + String(Date.now() - started) + 'ms，正文=' + completion.text.slice(0, 40) +
          '，tokens=' + String(completion.inputTokens) + '/' + String(completion.outputTokens),
      );
      expect(auditEntries.map((entry) => entry.decision)).toEqual(['allowed']);

      // 6) 回写成功状态与事件。
      await repository.markSucceeded({
        runId,
        outputSummary: {
          smoke: true,
          provider_status: response.statusCode,
          event_count: completion.eventCount,
          text_length: completion.text.length,
        },
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        actualModelProfile: connection.default_model_id,
      });

      const finalRun = await pool.query(SQL_SELECT_RUN, [runId]);
      const runRow = finalRun.rows[0] as Record<string, unknown>;
      const finalEvents = await pool.query(SQL_SELECT_EVENTS, [runId]);
      expect(runRow.status).toBe('succeeded');
      expect(runRow.error_code).toBeNull();
      expect(finalEvents.rows.map((row) => (row as { event_type: string }).event_type)).toEqual([
        'run.started',
        'run.succeeded',
      ]);
      console.log('  · 回写完成：状态=succeeded，事件序列=' + JSON.stringify(finalEvents.rows.map((row) => (row as { sequence_no: number }).sequence_no)));

      // 7) 幂等性：再次领取不得产生任何新事件。
      const secondClaim = await repository.beginExecution({ runId, traceId, retryCount: 0 });
      expect(secondClaim.shouldExecute).toBe(false);
      const eventsAfterSecondClaim = await pool.query(SQL_SELECT_EVENTS, [runId]);
      expect(eventsAfterSecondClaim.rows).toHaveLength(2);
      console.log('  · 重复投递验证：shouldExecute=false，事件数仍为 2');

      console.log('  · 清理 SQL：DELETE FROM agent.agent_run_events WHERE agent_run_id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM agent.agent_runs WHERE id = ' + runId + ';');
      console.log('  · 清理 SQL：DELETE FROM public.learning_goals WHERE id = ' + goalId + ';');
    } finally {
      await pool.end();
    }
  }, 180_000);
});
