/**
 * BullMQ 消费适配器（等价于 Python 的 interfaces/celery/tasks.py）。
 *
 * 职责：把队列任务转换为命令层调用，并把失败结果映射为 BullMQ 语义：
 * - 可重试且未耗尽 → 已在数据库中记录下一次重试，抛出普通错误让 BullMQ 按退避重投；
 * - 已终态（不可重试、重试耗尽、未分类异常）→ 抛出 UnrecoverableError，不再重投；
 * - 载荷不符合契约（拿不到 agent_run_id）→ 直接 UnrecoverableError，不写任何运行状态。
 *
 * 导出：
 * - AgentRunJobPayloadSchema：队列载荷的运行时校验。
 * - createAgentRunProcessor：构造 BullMQ 处理器。
 */

import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';

import {
  executeAgentRun,
  handleAgentRunFailure,
  type AgentRunRepositoryPort,
  type WorkflowRegistryPort,
} from '../../application/commands/execute-agent-run.js';
import type { AgentRunJobPayload } from '../../infrastructure/queue/bullmq-agent-queue.js';

export const AgentRunJobPayloadSchema = z
  .object({
    agent_run_id: z.uuid(),
    trace_id: z.string().min(1).max(128),
    task_version: z.literal(1),
  })
  .strict();

export interface AgentRunProcessorDeps {
  repository: AgentRunRepositoryPort;
  workflows: WorkflowRegistryPort;
  /** 业务重试次数上限，与队列 attempts 保持一致（attempts = maxRetries + 1）。 */
  maxRetries: number;
}

export function createAgentRunProcessor(
  deps: AgentRunProcessorDeps,
): (job: Job<AgentRunJobPayload>) => Promise<void> {
  return async (job) => {
    const parsed = AgentRunJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      // 载荷不符合契约时无法定位运行，不能写任何运行状态。
      throw new UnrecoverableError('AgentRun 队列载荷不符合契约。');
    }
    const task = {
      agentRunId: parsed.data.agent_run_id,
      traceId: parsed.data.trace_id,
      taskVersion: 1 as const,
    };

    try {
      await executeAgentRun({
        task,
        retryCount: job.attemptsMade,
        repository: deps.repository,
        workflows: deps.workflows,
      });
    } catch (error) {
      const failure = await handleAgentRunFailure({
        runId: task.agentRunId,
        retryCount: job.attemptsMade,
        maxRetries: deps.maxRetries,
        error,
        repository: deps.repository,
      });
      if (failure.action === 'retry') {
        // 让 BullMQ 按 backoffStrategy 重投；数据库已记录下一次重试。
        throw error instanceof Error ? error : new Error(String(error));
      }
      throw new UnrecoverableError('AgentRun 已写入终态失败：' + failure.code);
    }
  };
}
