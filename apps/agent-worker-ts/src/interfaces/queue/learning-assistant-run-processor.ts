/**
 * 学习助手 BullMQ 消费适配器。
 *
 * 调用顺序：校验学习助手 Job 载荷 → 调用 PostgreSQL Repository 原子领取 queued 运行
 * → 已领取运行读取服务端模型连接、恢复 Checkpoint 并执行 LangGraph → 幂等回写消息与终态。
 * 载荷契约错误和归属错误直接终止重试，数据库或临时依赖错误交给 BullMQ 重试。
 */

import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';

import {
  LearningAssistantRunContractError,
  type PgLearningAssistantRunQueueRepository,
} from '../../infrastructure/database/learning-assistant-run-queue-repository.js';
import type { LearningAssistantJobPayload } from '../../infrastructure/queue/bullmq-agent-queue.js';
import type { CoreInternalClient } from '../../acl/core-internal-client.js';
import type { ModelPort, LearningAssistantReactLimits } from '../../workflows/learning-assistant/ports.js';
import type { FileLearningSkills } from '../../application/services/learning-skills.js';
import type { ToolGatewayPort } from '../../application/services/tool-aware-generator.js';
import type { ModelProviderConnection } from '../../infrastructure/llm/model-gateway.js';
import type { ModelCredentialDecryptor } from '../../infrastructure/llm/credential-decryptor.js';
import type { LearningAssistantCheckpointer } from '../../infrastructure/langgraph/learning-assistant-checkpointer.js';
import { createLearningAssistantGraph, runLearningAssistant } from '../../workflows/learning-assistant/index.js';
import { PgLearningAssistantRuntimeStore } from '../../infrastructure/database/learning-assistant-runtime-store.js';
import type { LearningAssistantDependencies } from '../../workflows/learning-assistant/ports.js';

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
  repository: Pick<PgLearningAssistantRunQueueRepository, 'beginExecution'> & Partial<Pick<PgLearningAssistantRunQueueRepository, 'pool' | 'bindModel' | 'loadRunInput' | 'loadInitialMessages' | 'persistMessages' | 'finishSucceeded' | 'finishFailed' | 'readBusinessTool'>>;
  internalClient?: Pick<CoreInternalClient, 'getLearningAssistantDefaultModelConnection'>;
  decryptor?: Pick<ModelCredentialDecryptor, 'decrypt'>;
  model?: ModelPort;
  skills?: Pick<FileLearningSkills, 'listSkills' | 'loadSkill'>;
  createTavily?: (ownerId: string) => ToolGatewayPort;
  reactLimits?: LearningAssistantReactLimits;
  checkpointer?: LearningAssistantCheckpointer;
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
    let shouldExecute = false;
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
      shouldExecute = state.shouldExecute;
      if (state.shouldExecute) {
        if (!deps.repository.pool || !deps.repository.bindModel || !deps.repository.loadRunInput || !deps.repository.loadInitialMessages || !deps.repository.persistMessages
          || !deps.repository.finishSucceeded || !deps.repository.finishFailed || !deps.repository.readBusinessTool
          || !deps.internalClient || !deps.decryptor || !deps.model || !deps.skills || !deps.createTavily || !deps.reactLimits || !deps.checkpointer) return;
        const loadRunInput = deps.repository.loadRunInput;
        const loadInitialMessages = deps.repository.loadInitialMessages;
        const persistMessages = deps.repository.persistMessages;
        const readBusinessTool = deps.repository.readBusinessTool;
        const envelope = await deps.internalClient.getLearningAssistantDefaultModelConnection(parsed.data.run_id);
        if (envelope.owner_id !== parsed.data.owner_id) throw new UnrecoverableError('模型连接所有者与运行不一致。');
        const apiKey = deps.decryptor.decrypt(envelope.owner_id, envelope.credential);
        const connection: ModelProviderConnection = { ownerId: envelope.owner_id, connectionId: envelope.connection_id,
          baseUrl: envelope.base_url, modelId: envelope.model_id, apiKey };
        await deps.repository.bindModel(parsed.data.run_id, parsed.data.owner_id, connection.connectionId, connection.modelId);
        const rawInput = await loadRunInput.call(deps.repository, { ...parsed.data, connectionId: connection.connectionId, modelId: connection.modelId, taskVersion: 1,
          runId: parsed.data.run_id, conversationId: parsed.data.conversation_id, ownerId: parsed.data.owner_id, triggerMessageId: parsed.data.trigger_message_id, traceId: parsed.data.trace_id });
        const input = { ...rawInput, connection_id: connection.connectionId, model_id: connection.modelId };
        const runtime = new PgLearningAssistantRuntimeStore(deps.repository.pool);
        const graphDeps: LearningAssistantDependencies = {
          checkpointer: deps.checkpointer.saver, model: deps.model, connection, trace: runtime,
          reserveModelAttempt: (value) => runtime.reserveModelAttempt(value), reactLimits: deps.reactLimits,
          skills: deps.skills, tavily: deps.createTavily(connection.ownerId),
          readBusinessTool: (name, value) => readBusinessTool.call(deps.repository, name, value),
          loadInitialMessages: (value) => loadInitialMessages.call(deps.repository, value.conversation_id, value.owner_id),
          persistMessages: (value, messages) => persistMessages.call(deps.repository, value, messages),
          validateLearningMemory: async () => false,
          persistLearningMemory: async () => undefined,
        };
        const graph = createLearningAssistantGraph(graphDeps);
        const result = await runLearningAssistant(graph, graphDeps, input);
        await deps.repository.finishSucceeded(input, { intent: result.intent, stage: result.stage, response: result.response,
          modelCallCount: result.modelStep, toolCallCount: 0 });
      }
    } catch (error) {
      if (shouldExecute && deps.repository.finishFailed) await deps.repository.finishFailed({
        runId: parsed.data.run_id, conversationId: parsed.data.conversation_id, ownerId: parsed.data.owner_id,
        triggerMessageId: parsed.data.trigger_message_id, connectionId: parsed.data.connection_id, modelId: parsed.data.model_id,
        traceId: parsed.data.trace_id, taskVersion: 1,
      }, error).catch(() => undefined);
      if (error instanceof LearningAssistantRunContractError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

