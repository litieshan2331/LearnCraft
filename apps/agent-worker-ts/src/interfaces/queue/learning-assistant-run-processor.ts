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
import type { ConversationMessage } from '../../workflows/learning-assistant/state.js';

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
  repository: Pick<PgLearningAssistantRunQueueRepository, 'beginExecution'> & Partial<Pick<PgLearningAssistantRunQueueRepository, 'pool' | 'bindModel' | 'loadRunInput'>>;
  internalClient?: Pick<CoreInternalClient, 'getLearningAssistantDefaultModelConnection' | 'getLearningAssistantContext' | 'appendLearningAssistantMessages' | 'finishLearningAssistantRun' | 'persistLearningAssistantMemory'>;
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
        if (!deps.repository.pool || !deps.repository.bindModel || !deps.repository.loadRunInput
          || !deps.internalClient || !deps.decryptor || !deps.model || !deps.skills || !deps.createTavily || !deps.reactLimits || !deps.checkpointer) {
          if (deps.internalClient === undefined) return;
          throw new Error('学习助手 Worker 运行依赖未完整装配。');
        }
        const loadRunInput = deps.repository.loadRunInput;
        const envelope = await deps.internalClient.getLearningAssistantDefaultModelConnection(parsed.data.run_id);
        if (envelope.owner_id !== parsed.data.owner_id) throw new UnrecoverableError('模型连接所有者与运行不一致。');
        const apiKey = deps.decryptor.decrypt(envelope.owner_id, envelope.credential);
        const connection: ModelProviderConnection = { ownerId: envelope.owner_id, connectionId: envelope.connection_id,
          baseUrl: envelope.base_url, modelId: envelope.model_id, apiKey };
        await deps.repository.bindModel(parsed.data.run_id, parsed.data.owner_id, connection.connectionId, connection.modelId);
        const rawInput = await loadRunInput.call(deps.repository, { ...parsed.data, connectionId: connection.connectionId, modelId: connection.modelId, taskVersion: 1,
          runId: parsed.data.run_id, conversationId: parsed.data.conversation_id, ownerId: parsed.data.owner_id, triggerMessageId: parsed.data.trigger_message_id, traceId: parsed.data.trace_id });
        const input = { ...rawInput, connection_id: connection.connectionId, model_id: connection.modelId };
        const trustedContext = await deps.internalClient.getLearningAssistantContext(parsed.data.run_id);
        const runtime = new PgLearningAssistantRuntimeStore(deps.repository.pool);
        const graphDeps: LearningAssistantDependencies = {
          checkpointer: deps.checkpointer.saver, model: deps.model, connection, trace: runtime,
          reserveModelAttempt: (value) => runtime.reserveModelAttempt(value), reactLimits: deps.reactLimits,
          skills: deps.skills, tavily: deps.createTavily(connection.ownerId),
          readBusinessTool: async (name) => ({
            data: name === 'get_wrong_question' ? trustedContext.wrong_question ?? {}
              : name === 'get_user_profile' ? trustedContext.user_profile ?? {}
                : name === 'get_mastery_state' ? trustedContext.mastery_state ?? {}
                  : trustedContext.learning_context ?? {},
            evidence: name === 'get_wrong_question' ? trustedContext.evidence : [],
          }),
          loadInitialMessages: async () => trustedContext.recent_messages.map(toConversationMessage),
          persistMessages: async (value, messages) => {
            await deps.internalClient!.appendLearningAssistantMessages(value.run_id, { messages: messages.map(toInternalMessage) });
          },
          validateLearningMemory: async (value, candidate) => (await deps.internalClient!.persistLearningAssistantMemory(value.run_id, { operation: 'validate', candidate })).accepted,
          persistLearningMemory: async (value, candidate) => { await deps.internalClient!.persistLearningAssistantMemory(value.run_id, { operation: 'write', candidate }); },
        };
        const graph = createLearningAssistantGraph(graphDeps);
        const result = await runLearningAssistant(graph, graphDeps, input);
        await deps.internalClient.finishLearningAssistantRun(parsed.data.run_id, {
          status: 'succeeded', model_id: connection.modelId, model_call_count: result.modelStep,
          tool_call_count: result.messages.filter((message) => message.role === 'tool').length,
          output_summary_json: { intent: result.intent, stage: result.stage, response: result.response },
          conversation: { stage: result.stage, state_json: { intent: result.intent, response: result.response, pending_question: result.pendingQuestion, hint_level: result.hintLevel } },
        });
      }
    } catch (error) {
      if (shouldExecute && deps.internalClient) await deps.internalClient.finishLearningAssistantRun(parsed.data.run_id, {
        status: 'failed', error_code: 'LEARNING_ASSISTANT_EXECUTION_FAILED', error_summary: error instanceof Error ? error.message.slice(0, 500) : '学习助手运行失败。',
      }).catch(() => undefined);
      if (error instanceof LearningAssistantRunContractError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

/** 将内部上下文消息转换成图使用的模型消息，并保留稳定消息 ID。 */
function toConversationMessage(message: { id: string; turn_no: number; role: ConversationMessage['role']; content: string | null; tool_call_id: string | null; name: string | null; tool_calls: Array<{ id: string; name: string; arguments_json: string }> }): ConversationMessage {
  return {
    id: message.id, turnNo: message.turn_no, role: message.role, content: message.content,
    ...(message.tool_call_id === null ? {} : { toolCallId: message.tool_call_id }),
    ...(message.name === null ? {} : { name: message.name }),
    ...(message.tool_calls.length === 0 ? {} : { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.arguments_json })) }),
  };
}

/** 将图消息转换为内部消息接口的蛇形字段，并保留工具调用参数。 */
function toInternalMessage(message: ConversationMessage): Record<string, unknown> {
  if (message.role === 'user') throw new Error('学习助手 Worker 不允许通过结果接口伪造用户消息。');
  return {
    id: message.id, role: message.role, content: message.content,
    turn_no: message.turnNo, tool_call_id: message.toolCallId ?? null, name: message.name ?? null,
    tool_calls: (message.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, arguments_json: call.argumentsJson })),
  };
}

