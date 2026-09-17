/**
 * AgentRun 生命周期的 PostgreSQL Repository（等价于 Python 的 SqlAlchemyAgentRunRepository）。
 *
 * 职责：只维护 agent schema 中的运行状态与有序事件，绝不写入 Web 核心业务表。
 * 关键不变量：
 * - 每次变更都在同一事务内先对 agent_runs 取 FOR UPDATE 行锁；
 * - 事件序号在行锁内以 MAX(sequence_no)+1 生成，由 uq_agent_run_events_sequence 兜底；
 * - 终态（succeeded/failed/cancelled/expired）短路所有变更，保证重复投递幂等；
 * - retry_count 单调不减；error_code/error_summary 按 100/1000 字符截断；
 * - 时间统一使用数据库 now()（Plan D12 方向）；与现状一致地**不更新** updated_at（Python 侧同样不更新）。
 *
 * 导出：
 * - TERMINAL_AGENT_RUN_STATUSES：终态集合。
 * - AgentRunExecutionState：领取后的可执行状态快照。
 * - AgentRunNotFoundError / AgentRunInvariantError：稳定错误分类。
 * - PoolLike / PoolClientLike：可注入的连接池端口（测试用假实现）。
 * - PgAgentRunRepository：beginExecution / isCancelled / markSucceeded / markRetryScheduled / markFailed。
 */

import pg from 'pg';

const { Pool } = pg;

export const TERMINAL_AGENT_RUN_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

const SQL_LOCK_RUN = [
  'SELECT id, owner_id, run_type, target_type, target_id, input_summary_json, status, retry_count, trace_id',
  'FROM agent.agent_runs',
  'WHERE id = $1',
  'FOR UPDATE',
].join(' ');

const SQL_MARK_RUNNING = [
  'UPDATE agent.agent_runs',
  "SET status = 'running', started_at = COALESCE(started_at, now()), retry_count = $2",
  'WHERE id = $1',
].join(' ');

const SQL_TOUCH_RETRY_COUNT = 'UPDATE agent.agent_runs SET retry_count = $2 WHERE id = $1';

const SQL_SELECT_STATUS = 'SELECT status FROM agent.agent_runs WHERE id = $1';

const SQL_MARK_SUCCEEDED = [
  'UPDATE agent.agent_runs',
  "SET status = 'succeeded', output_summary_json = $2::jsonb, input_tokens = $3, output_tokens = $4,",
  'actual_model_profile = $5, error_code = NULL, error_summary = NULL, finished_at = now()',
  'WHERE id = $1',
].join(' ');

const SQL_MARK_RETRY_SCHEDULED = [
  'UPDATE agent.agent_runs',
  "SET status = 'queued', retry_count = $2, error_code = $3, error_summary = NULL",
  'WHERE id = $1',
].join(' ');

const SQL_MARK_FAILED = [
  'UPDATE agent.agent_runs',
  "SET status = 'failed', error_code = $2, error_summary = $3, finished_at = now()",
  'WHERE id = $1',
].join(' ');

const SQL_LAST_SEQUENCE = [
  'SELECT COALESCE(MAX(sequence_no), 0) AS last_sequence_no',
  'FROM agent.agent_run_events',
  'WHERE agent_run_id = $1',
].join(' ');

const SQL_INSERT_EVENT = [
  'INSERT INTO agent.agent_run_events (agent_run_id, sequence_no, event_type, payload_json)',
  'VALUES ($1, $2, $3, $4::jsonb)',
].join(' ');

export interface AgentRunExecutionState {
  runId: string;
  ownerId: string;
  runType: string;
  targetType: string;
  targetId: string;
  inputSummaryJson: Record<string, unknown>;
  status: string;
  shouldExecute: boolean;
}

export class AgentRunNotFoundError extends Error {
  constructor(runId: string) {
    super('AgentRun 不存在：' + runId);
    this.name = 'AgentRunNotFoundError';
  }
}

export class AgentRunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunInvariantError';
  }
}

export interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

export interface PoolClientLike {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  release(): void;
}

export interface PoolLike {
  connect(): Promise<PoolClientLike>;
}

interface AgentRunRow {
  id: string;
  owner_id: string;
  run_type: string;
  target_type: string;
  target_id: string;
  input_summary_json: Record<string, unknown> | null;
  status: string;
  retry_count: number;
  trace_id: string;
}

function toExecutionState(row: AgentRunRow, shouldExecute: boolean): AgentRunExecutionState {
  return {
    runId: row.id,
    ownerId: row.owner_id,
    runType: row.run_type,
    targetType: row.target_type,
    targetId: row.target_id,
    inputSummaryJson: row.input_summary_json ?? {},
    status: row.status,
    shouldExecute,
  };
}

export class PgAgentRunRepository {
  constructor(private readonly pool: PoolLike) {}

  /** 以连接串创建默认连接池。 */
  static fromConnectionString(connectionString: string): PgAgentRunRepository {
    return new PgAgentRunRepository(new Pool({ connectionString, max: 10 }));
  }

  /** 领取运行：加行锁、校验 trace、推进状态并追加事件；已终止的运行返回 shouldExecute=false。 */
  async beginExecution(input: {
    runId: string;
    traceId: string;
    retryCount: number;
  }): Promise<AgentRunExecutionState> {
    return this.inTransaction(async (client) => {
      const row = await this.getLockedRun(client, input.runId);
      if (row.trace_id !== input.traceId) {
        throw new AgentRunInvariantError('任务载荷的 trace_id 与 AgentRun 不匹配。');
      }
      if (TERMINAL_AGENT_RUN_STATUSES.has(row.status)) {
        return toExecutionState(row, false);
      }

      const retryCount = Math.max(row.retry_count, input.retryCount);
      if (row.status === 'queued') {
        await client.query(SQL_MARK_RUNNING, [row.id, retryCount]);
        await this.appendEvent(client, row.id, 'run.started', { retry_count: retryCount });
        return toExecutionState({ ...row, status: 'running', retry_count: retryCount }, true);
      }
      if (row.status === 'running') {
        await client.query(SQL_TOUCH_RETRY_COUNT, [row.id, retryCount]);
        await this.appendEvent(client, row.id, 'run.resumed', { retry_count: retryCount });
        return toExecutionState({ ...row, retry_count: retryCount }, true);
      }
      throw new AgentRunInvariantError('不支持的 AgentRun 状态：' + row.status);
    });
  }

  /** 查询 Web 是否已把当前运行标记为协作式取消。 */
  async isCancelled(runId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(SQL_SELECT_STATUS, [runId]);
      const row = result.rows[0];
      return row !== undefined && row.status === 'cancelled';
    } finally {
      client.release();
    }
  }

  /** 写入成功摘要与 token 用量，并追加 run.succeeded 事件。 */
  async markSucceeded(input: {
    runId: string;
    outputSummary: Record<string, unknown>;
    inputTokens?: number;
    outputTokens?: number;
    actualModelProfile?: string | null;
  }): Promise<void> {
    await this.inTransaction(async (client) => {
      const row = await this.getLockedRun(client, input.runId);
      if (TERMINAL_AGENT_RUN_STATUSES.has(row.status)) {
        return;
      }
      const inputTokens = Math.max(0, input.inputTokens ?? 0);
      const outputTokens = Math.max(0, input.outputTokens ?? 0);
      await client.query(SQL_MARK_SUCCEEDED, [
        row.id,
        JSON.stringify(input.outputSummary),
        inputTokens,
        outputTokens,
        input.actualModelProfile ?? null,
      ]);
      await this.appendEvent(client, row.id, 'run.succeeded', {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    });
  }

  /** 记录可恢复错误并把运行重置为待重试；delay_seconds 只写入事件，实际延迟由队列负责。 */
  async markRetryScheduled(input: {
    runId: string;
    retryCount: number;
    delaySeconds: number;
    errorCode: string;
  }): Promise<void> {
    await this.inTransaction(async (client) => {
      const row = await this.getLockedRun(client, input.runId);
      if (TERMINAL_AGENT_RUN_STATUSES.has(row.status)) {
        return;
      }
      const retryCount = Math.max(row.retry_count, input.retryCount);
      await client.query(SQL_MARK_RETRY_SCHEDULED, [row.id, retryCount, input.errorCode]);
      await this.appendEvent(client, row.id, 'run.retry_scheduled', {
        retry_count: retryCount,
        delay_seconds: input.delaySeconds,
        error_code: input.errorCode,
      });
    });
  }

  /** 写入最终失败状态；摘要按 1000 字符截断，避免把敏感输入带入日志。 */
  async markFailed(input: { runId: string; errorCode: string; errorSummary: string }): Promise<void> {
    await this.inTransaction(async (client) => {
      const row = await this.getLockedRun(client, input.runId);
      if (TERMINAL_AGENT_RUN_STATUSES.has(row.status)) {
        return;
      }
      const errorCode = input.errorCode.slice(0, 100);
      await client.query(SQL_MARK_FAILED, [row.id, errorCode, input.errorSummary.slice(0, 1_000)]);
      await this.appendEvent(client, row.id, 'run.failed', { error_code: errorCode });
    });
  }

  /** 关闭底层连接池（仅在使用 fromConnectionString 创建时需要）。 */
  async close(): Promise<void> {
    const pool = this.pool as { end?: () => Promise<void> };
    if (typeof pool.end === 'function') {
      await pool.end();
    }
  }

  private async getLockedRun(client: PoolClientLike, runId: string): Promise<AgentRunRow> {
    const result = await client.query(SQL_LOCK_RUN, [runId]);
    const row = result.rows[0] as unknown as AgentRunRow | undefined;
    if (row === undefined) {
      throw new AgentRunNotFoundError(runId);
    }
    return row;
  }

  /** 在已持有的行锁下追加严格递增的审计事件。 */
  private async appendEvent(
    client: PoolClientLike,
    agentRunId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const last = await client.query(SQL_LAST_SEQUENCE, [agentRunId]);
    const lastSequenceNo = Number(last.rows[0]?.last_sequence_no ?? 0);
    await client.query(SQL_INSERT_EVENT, [
      agentRunId,
      lastSequenceNo + 1,
      eventType,
      JSON.stringify(payload),
    ]);
  }

  private async inTransaction<T>(work: (client: PoolClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败不应掩盖原始错误。
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
