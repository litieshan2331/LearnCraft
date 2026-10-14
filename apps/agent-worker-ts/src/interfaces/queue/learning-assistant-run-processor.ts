/**
 * 学习助手 BullMQ 消费适配器。
 *
 * 调用顺序：校验学习助手 Job 载荷 → 调用 PostgreSQL Repository 原子领取 queued 运行
 * → 已领取或重复任务返回成功；本阶段不执行 LangGraph，下一阶段由执行器接管 running 运行。
 * 载荷契约错误和归属错误直接终止重试，数据库或临时依赖错误交给 BullMQ 重试。
 */

import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';

import {
  LearningAssistantRunContractError,
  type PgLearningAssistantRunQueueRepository,
} from '../../infrastructure/database/learning-assistant-run-queue-repository.js';
import type { LearningAssistantJobPayload } from '../../infrastructure/queue/bullmq-agent-queue.js';

export const LearningAssistantJobPayloadSchema = z.object({
  run_id: z.uuid(),
  conversation_id: z.uuid(),
  owner_id: z.uuid(),
  trigger_message_id: z.uuid().nullable(),
  connection_id: z.uuid().nullable(),
  model_id: z.string().min(1).max(255).nullable(),
  trace_id: z.string().min(1).max(128),
  task_version: z.literal(1),
}).strict();

export interface LearningAssistantRunProcessorDeps {
  repository: Pick<PgLearningAssistantRunQueueRepository, 'beginExecution'>;
}

/** 创建学习助手 Job 处理器；同一 run_id 的重复投递不会重复领取。 */
export function createLearningAssistantRunProcessor(
  deps: LearningAssistantRunProcessorDeps,
): (job: Job<LearningAssistantJobPayload>) => Promise<void> {
  return async (job) => {
    const parsed = LearningAssistantJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError('学习助手队列载荷不符合契约。');
    }
    try {
      const state = await deps.repository.beginExecution({
        runId: parsed.data.run_id,
        conversationId: parsed.data.conversation_id,
        ownerId: parsed.data.owner_id,
        triggerMessageId: parsed.data.trigger_message_id,
        connectionId: parsed.data.connection_id,
        modelId: parsed.data.model_id,
        traceId: parsed.data.trace_id,
        taskVersion: 1,
      });
      if (state.shouldExecute) {
        // 第一阶段只验证队列领取和状态机；LangGraph 执行在下一阶段接入。
        return;
      }
    } catch (error) {
      if (error instanceof LearningAssistantRunContractError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

