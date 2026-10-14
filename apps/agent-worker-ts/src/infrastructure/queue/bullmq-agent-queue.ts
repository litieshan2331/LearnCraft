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
 * - LEARNING_ASSISTANT_JOB_NAME / LearningAssistantJobPayload：学习助手队列载荷契约。
 * - createAgentQueue / publishAgentRun / closeAgentQueue：发布侧。
 * - createLearningAssistantQueue / publishLearningAssistantRun：学习助手发布侧。
 * - createAgentRunWorker：消费侧。
 * - agentJobBackoffDelayMs：队列退避（与数据库记录的退避使用同一公式）。
 */

import { Queue, Worker, type Job, type Processor } from 'bullmq';

import { calculateRetryDelaySeconds } from '../../application/commands/execute-agent-run.js';
import type { AgentQueueConfig } from '../../bootstrap/config.js';
import type { AgentRunTask } from '../../application/commands/execute-agent-run.js';
import type { AgentRunPublisher } from './outbox-dispatcher.js';
import type { WorkflowPool } from './workflow-pool.js';

export const AGENT_RUN_JOB_NAME = 'agent.run';
export const LEARNING_ASSISTANT_JOB_NAME = 'learning_assistant.run';

export interface AgentRunJobPayload {
  agent_run_id: string;
  trace_id: string;
  task_version: 1;
}

export interface LearningAssistantRunTask {
  runId: string;
  conversationId: string;
  ownerId: string;
  triggerMessageId: string | null;
  connectionId: string | null;
  modelId: string | null;
  traceId: string;
  taskVersion: 1;
}

export interface LearningAssistantJobPayload {
  run_id: string;
  conversation_id: string;
  owner_id: string;
  trigger_message_id: string | null;
  connection_id: string | null;
  model_id: string | null;
  trace_id: string;
  task_version: 1;
}

/** 把命令层任务 DTO 转为队列载荷（snake_case，且不携带任何 Prompt 或凭据）。 */
export function toJobPayload(task: AgentRunTask): AgentRunJobPayload {
  return { agent_run_id: task.agentRunId, trace_id: task.traceId, task_version: task.taskVersion };
}

/** 把学习助手任务转换为不携带凭据的 snake_case BullMQ 载荷。 */
export function toLearningAssistantJobPayload(task: LearningAssistantRunTask): LearningAssistantJobPayload {
  return {
    run_id: task.runId,
    conversation_id: task.conversationId,
    owner_id: task.ownerId,
    trigger_message_id: task.triggerMessageId,
    connection_id: task.connectionId,
    model_id: task.modelId,
    trace_id: task.traceId,
    task_version: task.taskVersion,
  };
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

/** 创建学习助手专用 BullMQ 队列，与旧四类工作流使用不同队列键空间。 */
export function createLearningAssistantQueue(config: AgentQueueConfig): Queue<LearningAssistantJobPayload> {
  return new Queue<LearningAssistantJobPayload>(config.queueName, {
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

/** 发布学习助手运行；run_id 同时作为 BullMQ jobId，重复投递不会产生并行任务。 */
export async function publishLearningAssistantRun(
  queue: Queue<LearningAssistantJobPayload>,
  task: LearningAssistantRunTask,
  config: AgentQueueConfig,
): Promise<Job<LearningAssistantJobPayload>> {
  return queue.add(LEARNING_ASSISTANT_JOB_NAME, toLearningAssistantJobPayload(task), {
    jobId: task.runId,
    attempts: config.maxAttempts + 1,
    backoff: { type: 'custom' },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  });
}

export async function closeAgentQueue<T>(queue: Queue<T>): Promise<void> {
  await queue.close();
}

/** 把 BullMQ 队列适配为 Dispatcher 使用的投递端口。 */
/** 按资源池选择 BullMQ 队列；Outbox 重投仍使用同一工作流路由规则。 */
export function createBullMqPublisher(
  queues: { short: Queue<AgentRunJobPayload>; long: Queue<AgentRunJobPayload> },
  configs: { short: AgentQueueConfig; long: AgentQueueConfig },
): AgentRunPublisher {
  return {
    publish: async (task, pool: WorkflowPool) => {
      await publishAgentRun(queues[pool], task, configs[pool]);
    },
  };
}

/** 把学习助手队列适配为 Outbox Dispatcher 的专用投递端口。 */
export function createBullMqLearningAssistantPublisher(
  queue: Queue<LearningAssistantJobPayload>,
  config: AgentQueueConfig,
): { publishLearningAssistant(task: LearningAssistantRunTask): Promise<void> } {
  return {
    publishLearningAssistant: async (task) => {
      await publishLearningAssistantRun(queue, task, config);
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

/** 创建学习助手消费端；处理器抛出的普通错误会按同一退避策略重试。 */
export function createLearningAssistantWorker(
  config: AgentQueueConfig,
  processor: Processor<LearningAssistantJobPayload>,
): Worker<LearningAssistantJobPayload> {
  return new Worker<LearningAssistantJobPayload>(config.queueName, processor, {
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
