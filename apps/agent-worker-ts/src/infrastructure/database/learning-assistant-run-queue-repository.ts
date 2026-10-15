/**
 * 学习助手队列运行领取的 PostgreSQL 适配器。
 *
 * 调用顺序：BullMQ Processor 校验任务载荷 → beginExecution 按 run_id 加锁读取运行和会话
 * → 校验服务端注入的身份与关联字段 → 将 queued 原子更新为 running；重复投递只返回 shouldExecute=false。
 * 本文件同时提供 Worker 所需的运行输入、消息、业务事实和终态回写端口；不保存模型密钥。
 */

import type {
  LearningAssistantRunTask,
} from '../queue/bullmq-agent-queue.js';
import type { PoolLike } from './agent-run-repository.js';
import type { RunInput, BusinessToolName, BusinessResult } from '../../workflows/learning-assistant/schemas/index.js';
import type { ConversationMessage } from '../../workflows/learning-assistant/state.js';

const SQL_LOCK_RUN = [
  'SELECT r.id, r.conversation_id, r.owner_id, r.trigger_message_id, r.status,',
  '       c.status AS conversation_status',
  'FROM public.learning_assistant_runs r',
  'JOIN public.learning_assistant_conversations c ON c.id = r.conversation_id',
  'WHERE r.id = $1',
  'FOR UPDATE OF r',
].join(' ');

const SQL_MARK_RUNNING = [
  'UPDATE public.learning_assistant_runs',
  "SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()",
  "WHERE id = $1 AND status = 'queued'",
  'RETURNING status',
].join(' ');

export interface LearningAssistantRunExecutionState {
  runId: string;
  status: string;
  shouldExecute: boolean;
}

/** 任务不存在或载荷与数据库关联不一致时抛出的永久契约错误。 */
export class LearningAssistantRunContractError extends Error {
  /** 创建不会通过重试修复的运行契约错误。 */
  constructor(message: string) {
    super(message);
    this.name = 'LearningAssistantRunContractError';
  }
}

export class PgLearningAssistantRunQueueRepository {
  /** 注入共享 PostgreSQL 连接池；连接密钥只存在于 Worker 进程。 */
  constructor(public readonly pool: PoolLike) {}

  /** 使用最小连接池端口执行单条查询，兼容测试替身和 pg.Pool。 */
  private async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const client = await this.pool.connect();
    try { return await client.query(text, values); } finally { client.release(); }
  }

  /** 锁定运行并将 queued 原子推进到 running，终态或重复领取不再次执行。 */
  async beginExecution(task: LearningAssistantRunTask): Promise<LearningAssistantRunExecutionState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(SQL_LOCK_RUN, [task.runId]);
      const row = result.rows[0] as {
        id: string;
        conversation_id: string;
        owner_id: string;
        trigger_message_id: string | null;
        status: string;
        conversation_status: string;
      } | undefined;
      if (row === undefined) {
        throw new LearningAssistantRunContractError('学习助手运行不存在。');
      }
      if (String(row.conversation_id) !== task.conversationId
        || String(row.owner_id) !== task.ownerId
        || (row.trigger_message_id === null
          ? task.triggerMessageId !== null
          : String(row.trigger_message_id) !== task.triggerMessageId)) {
        throw new LearningAssistantRunContractError('学习助手队列载荷与运行归属不一致。');
      }
      // queued 是首次领取；running 可能来自 Worker 崩溃或 BullMQ 重试，
      // 允许同一 run 重新进入图并由 Checkpoint 决定恢复位置。
      if (row.status === 'running') {
        await client.query('COMMIT');
        return { runId: task.runId, status: row.status, shouldExecute: true };
      }
      if (row.status !== 'queued') {
        await client.query('COMMIT');
        return { runId: task.runId, status: row.status, shouldExecute: false };
      }
      if (row.conversation_status !== 'active') {
        throw new LearningAssistantRunContractError('学习助手会话已不可执行。');
      }
      const updated = await client.query(SQL_MARK_RUNNING, [task.runId]);
      await client.query('COMMIT');
      return {
        runId: task.runId,
        status: String(updated.rows[0]?.status ?? 'running'),
        shouldExecute: true,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 读取领取后的运行输入和触发用户消息；身份与题目关联均来自数据库。 */
  async loadRunInput(task: LearningAssistantRunTask): Promise<RunInput> {
    const result = await this.query(`SELECT r.id AS run_id, r.conversation_id, r.owner_id,
      r.trigger_message_id, c.source_assessment_answer_id, a.assessment_item_id AS question_id, m.turn_no, m.content
      FROM public.learning_assistant_runs r
      JOIN public.learning_assistant_conversations c ON c.id = r.conversation_id
      JOIN public.learning_assistant_messages m ON m.id = r.trigger_message_id
      LEFT JOIN public.assessment_answers a ON a.id = c.source_assessment_answer_id
      WHERE r.id = $1 AND r.conversation_id = $2 AND r.owner_id = $3`,
      [task.runId, task.conversationId, task.ownerId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined || typeof row.content !== 'string') {
      throw new LearningAssistantRunContractError('学习助手运行缺少有效的触发消息。');
    }
    if (task.triggerMessageId !== null && String(row.trigger_message_id) !== task.triggerMessageId) {
      throw new LearningAssistantRunContractError('学习助手触发消息与队列载荷不一致。');
    }
    return {
      run_id: String(row.run_id), conversation_id: String(row.conversation_id), owner_id: String(row.owner_id),
      connection_id: task.connectionId ?? '00000000-0000-4000-8000-000000000001',
      model_id: task.modelId ?? 'server-selected',
      message: { id: String(row.trigger_message_id), turn_no: Number(row.turn_no), content: row.content },
      question_id: row.question_id === null || row.question_id === undefined ? null : String(row.question_id),
    };
  }

  /** 在首次模型请求前固定连接身份；同一 run 恢复时拒绝切换到另一模型。 */
  async bindModel(runId: string, ownerId: string, connectionId: string, modelId: string): Promise<void> {
    const result = await this.query(`UPDATE public.learning_assistant_runs
      SET model_id = COALESCE(model_id, $4), input_summary_json = input_summary_json || $5::jsonb, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'running' AND (model_id IS NULL OR model_id = $4)
      RETURNING id`, [runId, ownerId, connectionId, modelId, JSON.stringify({ connection_id: connectionId })]);
    if (result.rows.length === 0) throw new LearningAssistantRunContractError('学习助手运行已绑定其他模型或不可执行。');
  }

  /** 冷启动读取完整历史；图内会按最近 20 轮裁剪，页面历史不受影响。 */
  async loadInitialMessages(conversationId: string, ownerId: string): Promise<ConversationMessage[]> {
    const result = await this.query(`SELECT m.id, m.turn_no, m.role, m.content, m.tool_call_id,
      m.tool_name, m.tool_input_json, m.tool_result_json, m.metadata_json
      FROM public.learning_assistant_messages m
      JOIN public.learning_assistant_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND c.owner_id = $2 ORDER BY m.sequence_no`, [conversationId, ownerId]);
    return result.rows.map((row) => {
      const metadata = (row.metadata_json ?? {}) as Record<string, unknown>;
      const toolCalls = Array.isArray(metadata.tool_calls) ? metadata.tool_calls : undefined;
      return {
        id: String(row.id), turnNo: Number(row.turn_no), role: row.role as ConversationMessage['role'],
        content: row.content === null ? null : String(row.content),
        ...(row.tool_call_id === null ? {} : { toolCallId: String(row.tool_call_id) }),
        ...(row.tool_name === null ? {} : { name: String(row.tool_name) }),
        ...(toolCalls === undefined ? {} : { toolCalls: toolCalls as ConversationMessage['toolCalls'] }),
      };
    });
  }

  /** 幂等保存图产生的助手/工具消息，消息 ID 是重试恢复的唯一键。 */
  async persistMessages(input: RunInput, messages: readonly ConversationMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query('SELECT conversation_id, status FROM public.learning_assistant_runs WHERE id = $1 AND owner_id = $2 FOR UPDATE', [input.run_id, input.owner_id]);
      if (run.rows.length === 0 || run.rows[0]?.status !== 'running') throw new Error('学习助手运行不可写入消息。');
      for (const message of messages) {
        const toolCalls = message.toolCalls === undefined ? [] : [...message.toolCalls];
        await client.query(`INSERT INTO public.learning_assistant_messages
          (id, conversation_id, sequence_no, turn_no, role, content, tool_name, tool_call_id, metadata_json)
          SELECT $1, $2, COALESCE(MAX(sequence_no), 0) + 1, $3, $4, $5, $6, $7, $8::jsonb
          FROM public.learning_assistant_messages WHERE conversation_id = $2
          ON CONFLICT (id) DO NOTHING`, [message.id, input.conversation_id, message.turnNo, message.role,
          message.content, message.name ?? null, message.toolCallId ?? null, JSON.stringify({ tool_calls: toolCalls })]);
      }
      await client.query('UPDATE public.learning_assistant_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [input.conversation_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** 运行成功后写入安全摘要和终态；同一结果重复回写保持幂等。 */
  async finishSucceeded(input: RunInput, state: { intent: unknown; stage: unknown; response: unknown; modelCallCount: number; toolCallCount: number; }): Promise<void> {
    await this.query(`UPDATE public.learning_assistant_runs SET status = 'succeeded', finished_at = now(),
      model_id = $4, model_call_count = GREATEST(model_call_count, $5), tool_call_count = GREATEST(tool_call_count, $6),
      output_summary_json = $7::jsonb, updated_at = now() WHERE id = $1 AND owner_id = $2 AND conversation_id = $3
      AND status IN ('running', 'succeeded')`, [input.run_id, input.owner_id, input.conversation_id, input.model_id,
      state.modelCallCount, state.toolCallCount, JSON.stringify({ intent: state.intent, stage: state.stage, response: state.response })]);
    await this.query(`UPDATE public.learning_assistant_conversations SET stage = $2,
      state_json = $3::jsonb, updated_at = now() WHERE id = $1`,
      [input.conversation_id, state.stage, JSON.stringify({ intent: state.intent, response: state.response })]);
  }

  /** 失败只保存稳定错误码和安全摘要，不把凭据或完整模型异常暴露给页面。 */
  async finishFailed(task: LearningAssistantRunTask, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 500) : '学习助手运行失败。';
    await this.query(`UPDATE public.learning_assistant_runs SET status = 'failed', finished_at = now(),
      error_code = 'LEARNING_ASSISTANT_EXECUTION_FAILED', error_summary = $4, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND conversation_id = $3 AND status = 'running'`, [task.runId, task.ownerId, task.conversationId, message]);
  }

  /** 读取首期支持的测评错题事实；画像、掌握度和经历由后续端口逐步扩展。 */
  async readBusinessTool(name: BusinessToolName, input: RunInput): Promise<BusinessResult> {
    if (name !== 'get_wrong_question') {
      return { data: {}, evidence: [] };
    }
    const result = await this.query(`SELECT a.id AS answer_id, i.id AS item_id, i.prompt, i.options_json,
      i.answer_key_json, i.explanation, a.answer_json, a.is_correct, a.feedback, a.weakness_tags
      FROM public.learning_assistant_conversations c
      JOIN public.assessment_answers a ON a.id = c.source_assessment_answer_id
      JOIN public.assessment_items i ON i.id = a.assessment_item_id
      WHERE c.id = $1 AND c.owner_id = $2`, [input.conversation_id, input.owner_id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return { data: {}, evidence: [] };
    return { data: { ...row }, evidence: [{ id: String(row.answer_id), kind: 'assessment_answer', source_id: String(row.answer_id), content: JSON.stringify(row), turn_no: null, executed: true }] };
  }
}

