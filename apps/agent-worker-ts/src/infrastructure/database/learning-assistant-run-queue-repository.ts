/**
 * 学习助手队列运行领取的 PostgreSQL 适配器。
 *
 * 调用顺序：BullMQ Processor 校验任务载荷 → beginExecution 按 run_id 加锁读取运行和会话
 * → 校验服务端注入的身份与关联字段 → 将 queued 原子更新为 running；重复投递只返回 shouldExecute=false。
 * 本文件只负责队列领取，不执行 LangGraph，也不写入模型回复。
 */

import type {
  LearningAssistantRunTask,
} from '../queue/bullmq-agent-queue.js';
import type { PoolLike } from './agent-run-repository.js';

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
  constructor(private readonly pool: PoolLike) {}

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
}

