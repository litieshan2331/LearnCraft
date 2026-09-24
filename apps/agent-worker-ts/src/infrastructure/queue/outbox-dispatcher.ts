/**
 * PostgreSQL Outbox 到 BullMQ 的可靠投递器（等价于 Python 的 OutboxDispatcher，并补齐优雅关闭）。
 *
 * 职责：以 FOR UPDATE OF o SKIP LOCKED 领取 Outbox 事件，校验契约后投递到队列，
 * 并把结果回写为 published / failed（退避） / dead。锁拥有者条件保证多实例不会互相覆盖状态。
 *
 * 与 Python 的关键差异（有意为之）：
 * - Python 运行时下线后只有本进程领取 Outbox，领取语句不再按 run_type 过滤；
 *   FOR UPDATE 必须写 **OF o**，否则会连带锁住 agent.agent_runs，与 beginExecution 的行锁互相阻塞；
 * - 增加优雅关闭：收到停止信号后不再领取，已领取但未发布的事件立即回写为 failed（available_at=now()），
 *   而不是等 900 秒锁租约。
 *
 * 导出：
 * - AgentRunPublisher：投递端口。
 * - ClaimedOutboxEvent：已领取的事件快照。
 * - OutboxDispatcher：dispatchOnce / run / stop。
 */

import { z } from 'zod';

import { calculateRetryDelaySeconds, type AgentRunTask } from '../../application/commands/execute-agent-run.js';
import type { OutboxDispatcherConfig } from '../../bootstrap/config.js';
import type { PoolClientLike, PoolLike } from '../database/agent-run-repository.js';
import { UnknownWorkflowPoolError, workflowPoolForRunType, type WorkflowPool } from './workflow-pool.js';

export const AgentRunTaskSchema = z
  .object({
    agent_run_id: z.uuid(),
    trace_id: z.string().min(1).max(128),
    task_version: z.literal(1),
  })
  .strict();

export interface AgentRunPublisher {
  publish(task: AgentRunTask, pool: WorkflowPool): Promise<void>;
}

export interface ClaimedOutboxEvent {
  id: string;
  aggregateId: string;
  eventVersion: number;
  payloadJson: unknown;
  runType: string;
  attemptCount: number;
}

/** 契约错误：事件永远无法投递，直接转 dead 等待人工处理。 */
export class OutboxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxContractError';
  }
}

/** 领取语句导出供集成测试在真实数据库上校验（尤其 FOR UPDATE OF o 的锁范围）。 */
export const SQL_CLAIM_EVENTS = [
  'WITH candidate AS (',
  '  SELECT o.id',
  '  FROM public.outbox_events o',
  '  JOIN agent.agent_runs r ON r.id = o.aggregate_id',
  '  WHERE o.event_type = $1',
  '    AND (',
  "      (o.status IN ('pending', 'failed') AND o.available_at <= now())",
  "      OR (o.status = 'processing' AND o.locked_at < now() - ($2::int * interval '1 second'))",
  '    )',
  '  ORDER BY o.created_at',
  '  FOR UPDATE OF o SKIP LOCKED',
  '  LIMIT $3',
  ')',
  'UPDATE public.outbox_events AS e',
  "SET status = 'processing', locked_by = $4, locked_at = now(),",
  '    attempt_count = e.attempt_count + 1, last_error = NULL',
  'FROM candidate',
  'WHERE e.id = candidate.id',
  'RETURNING e.id, e.aggregate_id, e.event_version, e.payload_json, e.attempt_count,',
  '  (SELECT r.run_type FROM agent.agent_runs r WHERE r.id = e.aggregate_id) AS run_type',
].join('\n');

const SQL_MARK_PUBLISHED = [
  'UPDATE public.outbox_events',
  "SET status = 'published', published_at = now(), locked_by = NULL, locked_at = NULL, last_error = NULL",
  "WHERE id = $1 AND status = 'processing' AND locked_by = $2",
].join(' ');

const SQL_MARK_DEAD = [
  'UPDATE public.outbox_events',
  "SET status = 'dead', locked_by = NULL, locked_at = NULL, last_error = $3",
  "WHERE id = $1 AND status = 'processing' AND locked_by = $2",
].join(' ');

const SQL_MARK_FAILED = [
  'UPDATE public.outbox_events',
  "SET status = 'failed', available_at = now() + ($3::int * interval '1 second'),",
  '    locked_by = NULL, locked_at = NULL, last_error = $4',
  "WHERE id = $1 AND status = 'processing' AND locked_by = $2",
].join(' ');

const SHUTDOWN_RELEASE_SUMMARY = 'Dispatcher 关闭时释放未投递事件';

export class OutboxDispatcher {
  private stopping = false;
  private inFlight: Promise<number> | null = null;
  private batchRunning = false;

  constructor(
    private readonly pool: PoolLike,
    private readonly publisher: AgentRunPublisher,
    private readonly config: OutboxDispatcherConfig,
  ) {}

  /** 领取并投递一个批次，返回本轮领取数量；批次内已领取但未发布的事件在关闭时会被释放。 */
  async dispatchOnce(): Promise<number> {
    const promise = this.dispatchBatch();
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  private async dispatchBatch(): Promise<number> {
    this.batchRunning = true;
    try {
      const claimed = await this.claimEvents();
      let processed = 0;
      for (const event of claimed) {
        if (this.stopping) {
          // 优雅关闭：不再发布，立即把锁释放回可重投状态，避免等待锁租约超时。
          await this.markFailed(event, SHUTDOWN_RELEASE_SUMMARY, 0);
          continue;
        }
        await this.dispatchEvent(event);
        processed += 1;
      }
      return processed;
    } finally {
      this.batchRunning = false;
    }
  }

  /** 持续投递直到 stop() 被调用。 */
  async run(): Promise<void> {
    while (!this.stopping) {
      const claimed = await this.dispatchOnce();
      if (claimed === 0 && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalSeconds * 1_000));
      }
    }
  }

  /**
   * 优雅关闭：停止领取，等待当前批次结束；批次内未发布的事件会在批次循环里被释放。
   * 若在批次内部调用（batchRunning=true），只设置标志并立即返回，避免 await 自身造成死锁。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.batchRunning) {
      return;
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  private async claimEvents(): Promise<ClaimedOutboxEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(SQL_CLAIM_EVENTS, [
        this.config.eventType,
        this.config.lockTimeoutSeconds,
        this.config.batchSize,
        this.config.dispatcherId,
      ]);
      await client.query('COMMIT');
      return result.rows.map((row) => ({
        id: String(row.id),
        aggregateId: String(row.aggregate_id),
        eventVersion: Number(row.event_version),
        payloadJson: row.payload_json,
        runType: String(row.run_type),
        attemptCount: Number(row.attempt_count),
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async dispatchEvent(event: ClaimedOutboxEvent): Promise<void> {
    let task: AgentRunTask;
    try {
      task = this.parseTask(event);
    } catch (error) {
      if (error instanceof OutboxContractError) {
        await this.markDead(event, error.message);
        return;
      }
      throw error;
    }

    let pool: WorkflowPool;
    try {
      pool = workflowPoolForRunType(event.runType);
    } catch (error) {
      if (!(error instanceof UnknownWorkflowPoolError)) {
        throw error;
      }
      // 沿用原有语义：未知类型交由 Worker 写入 AGENT_RUN_WORKFLOW_NOT_REGISTERED，避免 AgentRun 永远 queued。
      pool = 'short';
    }

    try {
      await this.publisher.publish(task, pool);
    } catch {
      await this.markRetryableFailure(event);
      return;
    }
    await this.markPublished(event);
  }

  /** 校验事件版本、载荷契约与聚合标识一致性；不满足即视为契约错误。 */
  private parseTask(event: ClaimedOutboxEvent): AgentRunTask {
    if (event.eventVersion !== 1) {
      throw new OutboxContractError('不支持的 Outbox 事件版本：' + String(event.eventVersion));
    }
    const parsed = AgentRunTaskSchema.safeParse(event.payloadJson);
    if (!parsed.success) {
      throw new OutboxContractError('Outbox 事件载荷不符合契约：AgentRunRequestedTask');
    }
    if (parsed.data.agent_run_id !== event.aggregateId) {
      throw new OutboxContractError('Outbox aggregate_id 与 agent_run_id 不一致。');
    }
    return {
      agentRunId: parsed.data.agent_run_id,
      traceId: parsed.data.trace_id,
      taskVersion: 1,
    };
  }

  private async markPublished(event: ClaimedOutboxEvent): Promise<void> {
    await this.executeUpdate(SQL_MARK_PUBLISHED, [event.id, this.config.dispatcherId]);
  }

  private async markDead(event: ClaimedOutboxEvent, errorSummary: string): Promise<void> {
    await this.executeUpdate(SQL_MARK_DEAD, [event.id, this.config.dispatcherId, errorSummary.slice(0, 1_000)]);
  }

  private async markRetryableFailure(event: ClaimedOutboxEvent): Promise<void> {
    if (event.attemptCount >= this.config.maxAttempts) {
      await this.markDead(event, '投递重试耗尽');
      return;
    }
    const delaySeconds = calculateRetryDelaySeconds(event.attemptCount, 10, this.config.maxBackoffSeconds);
    await this.markFailed(event, '投递到队列失败', delaySeconds);
  }

  private async markFailed(event: ClaimedOutboxEvent, errorSummary: string, delaySeconds: number): Promise<void> {
    await this.executeUpdate(SQL_MARK_FAILED, [
      event.id,
      this.config.dispatcherId,
      delaySeconds,
      errorSummary.slice(0, 1_000),
    ]);
  }

  /** 回写一律带锁拥有者条件，避免多实例相互覆盖状态。 */
  private async executeUpdate(sql: string, values: readonly unknown[]): Promise<void> {
    const client: PoolClientLike = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, values);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
