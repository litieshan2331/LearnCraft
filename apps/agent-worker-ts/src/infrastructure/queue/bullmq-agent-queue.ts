/**
 * BullMQ 队列的发布与消费装配（替代 Celery 的 send_task 与 worker 启动）。
 *
 * 职责：把队列配置收敛为 BullMQ 的 Queue / Worker 选项，并保证：
 * - jobId 使用 agent_run_id，天然去重，与数据库幂等键一致；
 * - attempts = maxRetries + 1，配合自定义退避复用 10/20/40… 封顶 300 秒的策略；
 * - lockDuration 大于任务硬超时，避免长任务被误判为 stalled 而重投；
 * - 键前缀与 Celery 的 learncraft:celery: 完全隔离。
 *
 * 导出：
 * - AGENT_RUN_JOB_NAME：业务队列中的任务名。
 * - AgentRunJobPayload / toJobPayload：队列载荷契约（snake_case，最小字段）。
 * - createAgentQueue / publishAgentRun / closeAgentQueue：发布侧。
 * - createAgentRunWorker：消费侧。
 * - agentJobBackoffDelayMs：队列退避（与数据库记录的退避使用同一公式）。
 */

import { Queue, Worker, type Job, type Processor } from 'bullmq';

import { calculateRetryDelaySeconds } from '../../application/commands/execute-agent-run.js';
import type { AgentQueueConfig } from '../../bootstrap/config.js';
import type { AgentRunTask } from '../../application/commands/execute-agent-run.js';
import type { AgentRunPublisher } from './outbox-dispatcher.js';

export const AGENT_RUN_JOB_NAME = 'agent.run';

export interface AgentRunJobPayload {
  agent_run_id: string;
  trace_id: string;
  task_version: 1;
}

/** 把命令层任务 DTO 转为队列载荷（snake_case，且不携带任何 Prompt 或凭据）。 */
export function toJobPayload(task: AgentRunTask): AgentRunJobPayload {
  return { agent_run_id: task.agentRunId, trace_id: task.traceId, task_version: task.taskVersion };
}

/** 队列退避：与 handleAgentRunFailure 写入数据库的延迟使用同一公式。 */
export function agentJobBackoffDelayMs(attemptsMade: number, config: AgentQueueConfig): number {
  return calculateRetryDelaySeconds(attemptsMade, config.backoffMs / 1000, config.backoffMaxMs / 1000) * 1000;
}

export function createAgentQueue(config: AgentQueueConfig): Queue<AgentRunJobPayload> {
  return new Queue<AgentRunJobPayload>(config.queueName, {
    connection: config.connection,
    prefix: config.prefix,
  });
}

/** 发布一条 AgentRun 任务；jobId 为 agent_run_id，重复发布不会产生第二个任务。 */
export async function publishAgentRun(
  queue: Queue<AgentRunJobPayload>,
  task: AgentRunTask,
  config: AgentQueueConfig,
): Promise<Job<AgentRunJobPayload>> {
  return queue.add(AGENT_RUN_JOB_NAME, toJobPayload(task), {
    jobId: task.agentRunId,
    attempts: config.maxAttempts + 1,
    backoff: { type: 'custom' },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  });
}

export async function closeAgentQueue(queue: Queue<AgentRunJobPayload>): Promise<void> {
  await queue.close();
}

/** 把 BullMQ 队列适配为 Dispatcher 使用的投递端口。 */
export function createBullMqPublisher(
  queue: Queue<AgentRunJobPayload>,
  config: AgentQueueConfig,
): AgentRunPublisher {
  return {
    publish: async (task) => {
      await publishAgentRun(queue, task, config);
    },
  };
}

/** 创建消费端；处理器抛出的普通错误会按自定义退避重投，UnrecoverableError 则直接失败。 */
export function createAgentRunWorker(
  config: AgentQueueConfig,
  processor: Processor<AgentRunJobPayload>,
): Worker<AgentRunJobPayload> {
  return new Worker<AgentRunJobPayload>(config.queueName, processor, {
    connection: config.connection,
    prefix: config.prefix,
    concurrency: config.concurrency,
    lockDuration: config.lockDurationMs,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        agentJobBackoffDelayMs(Math.max(1, attemptsMade), config),
    },
  });
}
