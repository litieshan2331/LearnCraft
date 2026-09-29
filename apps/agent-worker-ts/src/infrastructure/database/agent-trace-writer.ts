/**
 * Agent 观测事件的 PostgreSQL 写入器。
 *
 * 调用顺序：`append` 开启短事务并锁定 AgentRun，读取当前序号后插入一条 JSONB 事件，
 * 最后提交事务；锁保证同一运行的并发写入保持严格递增序号。
 */

import pg from 'pg';

import type {
  AgentTraceEventInput,
  TraceWriter,
} from '../../application/services/trace-writer.js';

const { Pool } = pg;

const SQL_LOCK_RUN = [
  'SELECT id FROM agent.agent_runs',
  'WHERE id = $1',
  'FOR UPDATE',
].join(' ');

const SQL_LAST_SEQUENCE = [
  'SELECT COALESCE(MAX(sequence_no), 0) AS last_sequence_no',
  'FROM agent.agent_trace_events',
  'WHERE agent_run_id = $1',
].join(' ');

const SQL_INSERT_TRACE = [
  'INSERT INTO agent.agent_trace_events',
  '(agent_run_id, sequence_no, event_type, turn_no, step_no, attempt_no,',
  'started_at, finished_at, input_tokens, output_tokens, payload_json)',
  'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)',
].join(' ');

/** PostgreSQL 连接池的最小查询端口，便于注入测试替身。 */
export interface TracePoolClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

/** PostgreSQL 连接池的最小连接端口。 */
export interface TracePool {
  connect(): Promise<TracePoolClient>;
}

/** 将写入输入转换为 PostgreSQL 可接受的非负 Token 数。 */
function tokenValue(value: number | undefined): number | null {
  return value === undefined ? null : Math.max(0, value);
}

/** 使用连接串创建观测写入器。 */
export function createPgTraceWriter(connectionString: string): PgTraceWriter {
  return new PgTraceWriter(new Pool({ connectionString, max: 10 }));
}

/** 以事务和 AgentRun 行锁写入完整观测事件。 */
export class PgTraceWriter implements TraceWriter {
  /** 创建使用指定 PostgreSQL 连接池的观测写入器。 */
  constructor(private readonly pool: TracePool) {}

  /** 写入一条观测事件并分配运行内连续序号。 */
  async append(event: AgentTraceEventInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(SQL_LOCK_RUN, [event.runId]);
      if (run.rows.length === 0) {
        throw new Error('AgentRun 不存在：' + event.runId);
      }
      const last = await client.query(SQL_LAST_SEQUENCE, [event.runId]);
      const lastSequenceNo = Number(last.rows[0]?.last_sequence_no ?? 0);
      await client.query(SQL_INSERT_TRACE, [
        event.runId,
        lastSequenceNo + 1,
        event.eventType,
        event.turnNo ?? null,
        event.stepNo ?? null,
        event.attemptNo ?? null,
        event.startedAt ?? null,
        event.finishedAt ?? null,
        tokenValue(event.inputTokens),
        tokenValue(event.outputTokens),
        JSON.stringify(event.payload),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败不应掩盖原始观测写入错误。
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** 关闭由 createPgTraceWriter 创建的底层连接池。 */
  async close(): Promise<void> {
    const pool = this.pool as { end?: () => Promise<void> };
    if (typeof pool.end === 'function') {
      await pool.end();
    }
  }
}
