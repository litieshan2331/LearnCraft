/**
 * 学习助手 LangGraph 主图编译与同线程运行恢复。
 * 调用顺序：createLearningAssistantGraph 装配节点 → runLearningAssistant 校验身份/连接 → 加载或恢复 Checkpoint → 普通回复 END。
 */
import { END, START, StateGraph } from '@langchain/langgraph';
import { createLearningAssistantThreadConfig } from '../../infrastructure/langgraph/learning-assistant-checkpointer.js';
import type { LearningAssistantDependencies } from './ports.js';
import { assertControlState, assertSupportedStateVersion, LEARNING_ASSISTANT_STATE_VERSION, LearningAssistantState, type AssistantState } from './state.js';
import { RunInputSchema, type RunInput } from './schemas/index.js';
import { runMainAgent } from './agents/main-agent.js';
import { runErrorAttributionAgent, runMainReadTool, runSocraticTutorAgent } from './agents/langchain-agent-runner.js';
import { stableId } from './agents/shared.js';
import { prepareAgent } from './nodes/load-context-node.js';
import { persistAgentResponse, persistMainIntermediateMessages } from './nodes/persist-nodes.js';

/** 编译独立图，复用 agent Schema 的 PostgreSQL Saver；测试可注入 MemorySaver。 */
export function createLearningAssistantGraph(deps: LearningAssistantDependencies) {
  return new StateGraph(LearningAssistantState)
    .addNode('prepare', /** 初始化本轮。 */ (state) => prepareAgent(deps, state))
    .addNode('main', /** 主 Agent 单轮决策。 */ (state) => runMainAgent(deps, state))
    .addNode('main_read_tool', /** 主 Agent 只读工具。 */ (state) => runMainReadTool(deps, state))
    .addNode('error_agent', /** 固定错题归因 Agent。 */ (state) => runErrorAttributionAgent(deps, state))
    .addNode('tutor_agent', /** 固定苏格拉底导师 Agent。 */ (state) => runSocraticTutorAgent(deps, state))
    .addNode('persist_main_messages', /** 主模型 Checkpoint 保存后再同步消息。 */ (state) => persistMainIntermediateMessages(deps, state))
    .addNode('persist', /** 幂等回复写入。 */ (state) => persistAgentResponse(deps, state))
    .addEdge(START, 'prepare').addEdge('prepare', 'main')
    .addConditionalEdges('main', (state) => {
      if (state.responseText !== null) return 'persist_main_messages';
      if (state.delegation?.target === 'error_attribution') return 'error_agent';
      if (state.delegation?.target === 'socratic_tutor') return 'tutor_agent';
      if (state.pendingMainToolCalls.length === 0) return 'main';
      return 'main_read_tool';
    })
    .addEdge('main_read_tool', 'main')
    .addEdge('error_agent', 'main')
    .addEdge('tutor_agent', 'main')
    .addConditionalEdges('persist_main_messages', (state) => state.responseText !== null ? 'persist' : 'main')
    .addEdge('persist', END)
    .compile({ checkpointer: deps.checkpointer });
}
export type LearningAssistantGraph = ReturnType<typeof createLearningAssistantGraph>;

/** 同一会话串行运行；未完成 run 用 null 从最新 Checkpoint 恢复，不重置预算和工具结果。 */
export async function runLearningAssistant(graph: LearningAssistantGraph, deps: LearningAssistantDependencies, rawInput: RunInput): Promise<AssistantState> {
  const input = RunInputSchema.parse(rawInput);
  if (deps.connection.ownerId !== input.owner_id || deps.connection.connectionId !== input.connection_id || deps.connection.modelId !== input.model_id) throw new Error('运行连接与服务端绑定身份不一致');
  // Agent 自身的 ReAct 上限负责正常收束；这里仅作为图节点异常回环的最后熔断。
  const config = { ...createLearningAssistantThreadConfig(input.conversation_id), recursionLimit: 512, durability: 'sync' as const };
  let saved = await graph.getState(config);
  let prior = saved.values as Partial<AssistantState>;
  if (prior.input !== undefined) {
    let checkpointMigrated = false;
    if (prior.stateVersion === 3) {
      const legacyInput = prior.input;
      if (saved.next.length === 0 && prior.responseText !== null) {
        // 已完成的 v3 会话消息结构兼容；补齐新图状态后允许继续新一轮对话。
        await graph.updateState(config, { stateVersion: LEARNING_ASSISTANT_STATE_VERSION, pendingMainToolCalls: [], delegation: null });
        checkpointMigrated = true;
      } else if (saved.next.includes('main') && prior.responseText === null) {
        if (legacyInput.run_id !== input.run_id && input.message.turn_no <= legacyInput.message.turn_no) {
          throw new Error('过期运行不能覆盖会话最新 Checkpoint');
        }
        if (legacyInput.run_id === input.run_id) {
          // 旧运行在主节点前中断时没有图级工具结果；保留旧输入并从主节点恢复。
          await graph.updateState(config, { stateVersion: LEARNING_ASSISTANT_STATE_VERSION, pendingMainToolCalls: [], delegation: null });
          checkpointMigrated = true;
        } else {
          // 前一轮已进入终态后，下一用户轮可以接管旧 v3 主节点挂起点，历史仍从业务消息表恢复。
          const legacyState = {
            ...prior,
            input,
            stateVersion: LEARNING_ASSISTANT_STATE_VERSION,
            activeRunId: '',
            pendingMainToolCalls: [],
            delegation: null,
          } as AssistantState;
          const prepared = await prepareAgent(deps, legacyState);
          await graph.updateState(config, { ...legacyState, ...prepared }, 'prepare');
          checkpointMigrated = true;
        }
      } else {
        assertSupportedStateVersion(prior.stateVersion);
      }
      saved = await graph.getState(config);
      prior = saved.values as Partial<AssistantState>;
    } else {
      assertSupportedStateVersion(prior.stateVersion);
      if (prior.stateVersion === LEARNING_ASSISTANT_STATE_VERSION
        && saved.next.includes('main')
        && prior.responseText === null
        && prior.input.run_id !== input.run_id) {
        if (input.message.turn_no <= prior.input.message.turn_no) throw new Error('过期运行不能覆盖会话最新 Checkpoint');
        // 前一运行已终态失败后留下的主节点挂起点，由已入队的新用户轮接管并从业务消息恢复。
        const staleState = {
          ...prior,
          input,
          activeRunId: '',
          pendingMainToolCalls: [],
          delegation: null,
        } as AssistantState;
        const prepared = await prepareAgent(deps, staleState);
        await graph.updateState(config, { ...staleState, ...prepared }, 'prepare');
        checkpointMigrated = true;
      }
    }
    if (checkpointMigrated) {
      saved = await graph.getState(config);
      prior = saved.values as Partial<AssistantState>;
    }
    const priorInput = prior.input;
    if (priorInput === undefined) throw new Error('Checkpoint 缺少运行输入');
    if (priorInput.owner_id !== input.owner_id || priorInput.conversation_id !== input.conversation_id) throw new Error('Checkpoint 身份不匹配');
    if (priorInput.run_id === input.run_id && JSON.stringify(priorInput) !== JSON.stringify(input)) throw new Error('同一运行输入发生变化');
    if (priorInput.run_id !== input.run_id && input.message.turn_no <= priorInput.message.turn_no) throw new Error('过期运行不能覆盖会话最新 Checkpoint');
    if (saved.next.length > 0 && priorInput.run_id !== input.run_id) throw new Error('会话仍有未完成运行，不允许覆盖 Checkpoint');
    if (prior.activeRunId === input.run_id && saved.next.length === 0 && prior.responseText !== null) return saved.values as AssistantState;
  }
  if (prior.input !== undefined) assertControlState(prior as AssistantState);
  const spanId = stableId(input.run_id);
  await deps.trace.append({ runId: input.run_id, eventType: 'run.started', spanId, parentSpanId: null, agentName: 'main', payload: { conversationId: input.conversation_id, connectionId: input.connection_id, modelId: input.model_id, resumed: saved.next.length > 0 } });
  try {
    const result = await graph.invoke(saved.next.length > 0 ? null : { input }, config);
    await deps.trace.append({ runId: input.run_id, eventType: 'run.completed', spanId, agentName: 'main', payload: { intent: result.intent, stage: result.stage } });
    return result;
  } catch (error) {
    await deps.trace.append({ runId: input.run_id, eventType: 'run.failed', spanId, agentName: 'main', payload: { message: error instanceof Error ? error.message : '图执行失败' } });
    throw error;
  }
}
