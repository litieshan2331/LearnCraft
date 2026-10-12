/**
 * 学习助手真实 PostgreSQL Checkpoint、预算、嵌套轨迹与幂等消息验收。
 * 调用顺序：显式测试配置 → 创建随机隔离用户/会话/run → 执行及重建图恢复 → 核对数据库 → 清理自身数据。
 * 不请求真实模型；LEARNING_ASSISTANT_TEST_USE_LOCAL_ENV=1 时从工程 .env 加载本地数据库配置。
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLearningAssistantCheckpointer } from '../../src/infrastructure/langgraph/learning-assistant-checkpointer.js';
import { PgLearningAssistantRuntimeStore } from '../../src/infrastructure/database/learning-assistant-runtime-store.js';
import { createLearningAssistantGraph, runLearningAssistant } from '../../src/workflows/learning-assistant/graph.js';
import type { LearningAssistantDependencies } from '../../src/workflows/learning-assistant/ports.js';
import type { RunInput } from '../../src/workflows/learning-assistant/schemas/index.js';
import type { ModelMessage } from '../../src/infrastructure/llm/model-gateway.js';
import { stableId } from '../../src/workflows/learning-assistant/agents/index.js';

if (process.env.LEARNING_ASSISTANT_TEST_USE_LOCAL_ENV === '1') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  for (const path of [resolve(root, 'infra/.env'), resolve(root, '.env')]) if (existsSync(path)) loadEnvFile(path);
}
const databaseUrl = process.env.LEARNING_ASSISTANT_TEST_DATABASE_URL
  ?? (process.env.LEARNING_ASSISTANT_TEST_USE_LOCAL_ENV === '1' ? process.env.DATABASE_URL : undefined);

describe.skipIf(!databaseUrl)('学习助手 PostgreSQL 图与轨迹', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 });
  const ownerId = randomUUID();
  const conversationIds: string[] = [];
  const store = new PgLearningAssistantRuntimeStore(pool);

  /** 创建仅属于本测试的用户，避免修改现有数据。 */
  beforeAll(async () => { await pool.query('INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)', [ownerId, 'graph-' + ownerId + '@example.invalid', '学习助手图测试', 'test-only']); });
  /** 仅清理本测试随机会话的 Checkpoint 和用户关联数据。 */
  afterAll(async () => {
    const saver = createLearningAssistantCheckpointer(databaseUrl!).saver;
    try { for (const id of conversationIds) await saver.deleteThread(id); await pool.query('DELETE FROM users WHERE id = $1', [ownerId]); }
    finally { await saver.end(); await pool.end(); }
  });

  /** 建立 running run，模型请求计数从0开始。 */
  async function input(): Promise<RunInput> {
    const run: RunInput = { run_id: randomUUID(), conversation_id: randomUUID(), owner_id: ownerId, connection_id: randomUUID(), model_id: 'fake', question_id: null, message: { id: randomUUID(), turn_no: 1, content: '分析代码边界' } };
    conversationIds.push(run.conversation_id);
    await pool.query('INSERT INTO learning_assistant_conversations (id, owner_id) VALUES ($1, $2)', [run.conversation_id, ownerId]);
    await pool.query('INSERT INTO learning_assistant_messages (id, conversation_id, sequence_no, turn_no, role, content) VALUES ($1, $2, 1, 1, $3, $4)', [run.message.id, run.conversation_id, 'user', run.message.content]);
    await pool.query(`INSERT INTO learning_assistant_runs (id, conversation_id, owner_id, trigger_message_id, idempotency_key, orchestration_version, status)
      VALUES ($1, $2, $3, $4, $5, 'graph.test.v1', 'running')`, [run.run_id, run.conversation_id, ownerId, run.message.id, randomUUID()]);
    return run;
  }

  /** 验证数据库计数是原子累加，跨实例恢复后仍可继续记录；ReAct 上限由图控制。 */
  it('并发预占全部成功，跨实例恢复保持计数', async () => {
    const run = await input();
    const results = await Promise.allSettled(Array.from({ length: 24 }, () => store.reserveModelAttempt(run)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(24);
    await expect(new PgLearningAssistantRuntimeStore(pool).reserveModelAttempt(run)).resolves.toBe(25);
    const count = await pool.query('SELECT model_call_count FROM learning_assistant_runs WHERE id = $1', [run.run_id]);
    expect(count.rows[0]?.model_call_count).toBe(25);
  });

  /** PostgreSQL 重建图后从子模型节点恢复，已保存的子工具结果不重复执行。 */
  it('真实 Checkpoint 恢复子 Agent，并保存嵌套轨迹和全部父消息', async () => {
    const run = await input();
    const script: Array<ModelMessage | Error> = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'delegate', name: 'analyze_wrong_answer', argumentsJson: '{"task":"分析边界"}' }] },
      { role: 'assistant', content: null, toolCalls: [{ id: 'profile', name: 'get_user_profile', argumentsJson: '{}' }] },
      new Error('模拟子模型崩溃'),
      { role: 'assistant', content: JSON.stringify({ status: 'insufficient_evidence', hypotheses: [], verification_direction: '核对迭代边界', verification: { status: 'not_verified', conclusion: '暂无推演证据', evidence_ids: [], demonstrated_progress: false } }) },
      { role: 'assistant', content: JSON.stringify({ intent: 'wrong_answer_analysis', explanation: '目前还需要具体的推演过程。', primary_question: '最后一次循环的下标是多少？', next_action: 'await_user', stage: 'waiting_for_user' }) },
    ];
    const saver = createLearningAssistantCheckpointer(databaseUrl!).saver;
    let reads = 0;
    const deps: LearningAssistantDependencies = {
      checkpointer: saver, trace: store,
      connection: { ownerId, connectionId: run.connection_id, modelId: run.model_id, baseUrl: 'https://example.invalid', apiKey: 'never-checkpoint-this' },
      reactLimits: { main: 6, error_attribution: 4, socratic_tutor: 4 },
      /** 原子持久化共享预算。 */ reserveModelAttempt: (value) => store.reserveModelAttempt(value),
      model: { /** 模拟实际网关事件与预算钩子。 */ async complete(request) {
        await request.beforeModelAttempt?.();
        await request.traceWriter?.append({ runId: run.run_id, eventType: 'llm.request.started', payload: { messages: request.messages } });
        const message = script.shift();
        if (message instanceof Error) throw message;
        if (message === undefined) throw new Error('测试脚本耗尽');
        await request.traceWriter?.append({ runId: run.run_id, eventType: 'llm.attempt.completed', inputTokens: 2, outputTokens: 3, payload: { response: message } });
        return { message, usage: { inputTokens: 2, outputTokens: 3 }, finishReason: 'stop' };
      } },
      skills: { /** 只返回摘要。 */ listSkills: () => [], /** 不在此用例加载正文。 */ loadSkill: () => '' },
      tavily: { /** 不出网。 */ async execute() { throw new Error('不应使用 Tavily'); } },
      /** 校验身份后返回可信事实。 */ async readBusinessTool(_name, value) { expect(value.owner_id).toBe(ownerId); reads += 1; return { data: { experience: null }, evidence: [] }; },
      /** 缺少初始 Checkpoint 时，用户消息仍由图按ID合并。 */ async loadInitialMessages() { return []; },
      /** 实际写入业务消息，固定 ID 去重；工具调用字段存内部 metadata。 */ async persistMessages(value, messages) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM learning_assistant_conversations WHERE id = $1 FOR UPDATE', [value.conversation_id]);
          for (const message of messages) {
            await client.query(`INSERT INTO learning_assistant_messages (id, conversation_id, sequence_no, turn_no, role, content, tool_name, tool_call_id, metadata_json)
              SELECT $1, $2, COALESCE(MAX(sequence_no), 0) + 1, $3, $4, $5, $6, $7, $8::jsonb
              FROM learning_assistant_messages WHERE conversation_id = $2 ON CONFLICT (id) DO NOTHING`, [message.id, value.conversation_id, message.turnNo, message.role, message.content, message.name ?? null, message.toolCallId ?? null, JSON.stringify({ toolCalls: message.toolCalls })]);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      },
      /** 本用例证据不足，拒绝记忆。 */ async validateLearningMemory() { return false; },
      /** 不应发生写入。 */ async persistLearningMemory() { throw new Error('不应写记忆'); },
    };
    let restored = saver;
    try {
      await expect(runLearningAssistant(createLearningAssistantGraph(deps), deps, run)).rejects.toThrow('模拟子模型崩溃');
      expect(reads).toBe(1);
      await saver.end();
      restored = createLearningAssistantCheckpointer(databaseUrl!).saver;
      deps.checkpointer = restored;
      const result = await runLearningAssistant(createLearningAssistantGraph(deps), deps, run);
      expect(reads).toBe(1); expect(result.pendingQuestion).toContain('下标');
      const events = await store.listOwnedEvents(ownerId, run.run_id);
      const delegate = events.find((event) => event.event_type === 'tool.started' && (event.payload_json as Record<string, unknown>).toolName === 'analyze_wrong_answer');
      expect(events.some((event) => event.agent_name === 'error_attribution' && event.parent_span_id === delegate?.span_id)).toBe(true);
      expect(await store.listOwnedEvents(randomUUID(), run.run_id)).toEqual([]);
      const stats = await pool.query('SELECT model_call_count, input_tokens, output_tokens, sub_agent_summary_json FROM learning_assistant_runs WHERE id = $1', [run.run_id]);
      expect(stats.rows[0]).toMatchObject({ model_call_count: 5, input_tokens: 8, output_tokens: 12 });
      expect(stats.rows[0]?.sub_agent_summary_json).toHaveLength(1);
      const messages = await pool.query('SELECT role FROM learning_assistant_messages WHERE conversation_id = $1 ORDER BY sequence_no', [run.conversation_id]);
      expect(messages.rows.map((row) => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      const checkpoint = await restored.getTuple({ configurable: { thread_id: run.conversation_id } });
      expect(JSON.stringify(checkpoint)).not.toContain('never-checkpoint-this');
      await runLearningAssistant(createLearningAssistantGraph(deps), deps, run);
      expect(script).toHaveLength(0);
    } finally { await restored.end(); }
  });

  /** 新表独立指向 public run，业务运行删除时轨迹随之清理，不影响旧表。 */
  it('轨迹外键级联删除且具有父子索引', async () => {
    const run = await input();
    await store.append({ runId: run.run_id, eventType: 'run.started', spanId: stableId(run.run_id), agentName: 'main', payload: {} });
    const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'agent' AND tablename = 'learning_assistant_trace_events'");
    expect(indexes.rows.map((row) => row.indexname)).toContain('idx_learning_assistant_trace_parent');
    await pool.query('DELETE FROM learning_assistant_runs WHERE id = $1', [run.run_id]);
    const events = await pool.query('SELECT 1 FROM agent.learning_assistant_trace_events WHERE run_id = $1', [run.run_id]);
    expect(events.rows).toHaveLength(0);
  });
});
