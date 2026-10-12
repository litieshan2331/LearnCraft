/**
 * 学习助手 LangGraph 主图编译与同线程运行恢复。
 * 调用顺序：createLearningAssistantGraph 装配节点 → runLearningAssistant 校验身份/连接 → 加载或恢复 Checkpoint → 普通回复 END。
 */
import { END, START, StateGraph } from '@langchain/langgraph';
import { createLearningAssistantThreadConfig } from '../../infrastructure/langgraph/learning-assistant-checkpointer.js';
import type { LearningAssistantDependencies } from './ports.js';
import { LearningAssistantState, type AssistantState } from './state.js';
import { RunInputSchema, type RunInput } from './schemas/index.js';
import { runMainAgent } from './agents/main-agent.js';
import { runErrorAttributionAgent } from './agents/error-attribution-agent.js';
import { runSocraticTutorAgent } from './agents/socratic-tutor-agent.js';
import { stableId } from './agents/shared.js';
import { prepareAgent } from './nodes/load-context-node.js';
import { runMainTool, runChildTool } from './nodes/tool-nodes.js';
import { persistAgentMemory, persistAgentResponse, persistMainIntermediateMessages } from './nodes/persist-nodes.js';

/** 按已保存的子角色分发到独立 Agent 文件，保持 child_model 节点及恢复游标。 */
async function runChildAgentNode(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.child === null) throw new Error('缺少子 Agent 状态');
  return state.child.actor === 'error_attribution'
    ? await runErrorAttributionAgent(deps, state)
    : await runSocraticTutorAgent(deps, state);
}

/** 主模型之后根据真实工具调用和校验结果继续或完成。 */
function afterMain(state: AssistantState): 'main_tool' | 'persist' | 'main' {
  return state.pending.length > 0 ? 'main_tool' : state.response !== null ? 'persist' : 'main';
}
/** 主工具串行游标可恢复；子 Agent 调用插入独立子模型/工具节点。 */
function afterMainTool(state: AssistantState): 'child_model' | 'main_tool' | 'main' {
  return state.child !== null ? 'child_model' : state.toolIndex < state.pending.length ? 'main_tool' : 'main';
}
/** 子输出完成后返回父工具；未完成则执行工具或一次结构修复。 */
function afterChild(state: AssistantState): 'main_tool' | 'child_tool' | 'child_model' {
  if (state.child?.result != null) return 'main_tool';
  return (state.child?.pending.length ?? 0) > 0 ? 'child_tool' : 'child_model';
}
/** 子工具也是单步节点，不在一个不可恢复节点中执行整个工具循环。 */
function afterChildTool(state: AssistantState): 'child_tool' | 'child_model' {
  return state.child !== null && state.child.index < state.child.pending.length ? 'child_tool' : 'child_model';
}

/** 编译独立图，复用 agent Schema 的 PostgreSQL Saver；测试可注入 MemorySaver。 */
export function createLearningAssistantGraph(deps: LearningAssistantDependencies) {
  return new StateGraph(LearningAssistantState)
    .addNode('prepare', /** 初始化本轮。 */ (state) => prepareAgent(deps, state))
    .addNode('main', /** 主模型请求。 */ (state) => runMainAgent(deps, state))
    .addNode('main_tool', /** 串行主工具。 */ (state) => runMainTool(deps, state))
    .addNode('persist_main_messages', /** 主模型 Checkpoint 保存后再同步消息。 */ (state) => persistMainIntermediateMessages(deps, state))
    .addNode('persist_tool_messages', /** 主工具 Checkpoint 保存后再同步结果。 */ (state) => persistMainIntermediateMessages(deps, state))
    .addNode('child_model', /** 按子角色分派模型请求。 */ (state) => runChildAgentNode(deps, state))
    .addNode('child_tool', /** 串行子工具。 */ (state) => runChildTool(deps, state))
    .addNode('persist', /** 幂等回复写入。 */ (state) => persistAgentResponse(deps, state))
    .addNode('memory', /** 服务端验证后记忆写入。 */ (state) => persistAgentMemory(deps, state))
    .addEdge(START, 'prepare').addEdge('prepare', 'main')
    .addEdge('main', 'persist_main_messages')
    .addConditionalEdges('persist_main_messages', afterMain)
    .addEdge('main_tool', 'persist_tool_messages')
    .addConditionalEdges('persist_tool_messages', afterMainTool)
    .addConditionalEdges('child_model', afterChild)
    .addConditionalEdges('child_tool', afterChildTool)
    .addEdge('persist', 'memory').addEdge('memory', END)
    .compile({ checkpointer: deps.checkpointer });
}
export type LearningAssistantGraph = ReturnType<typeof createLearningAssistantGraph>;

/** 同一会话串行运行；未完成 run 用 null 从最新 Checkpoint 恢复，不重置预算和工具结果。 */
export async function runLearningAssistant(graph: LearningAssistantGraph, deps: LearningAssistantDependencies, rawInput: RunInput): Promise<AssistantState> {
  const input = RunInputSchema.parse(rawInput);
  if (deps.connection.ownerId !== input.owner_id || deps.connection.connectionId !== input.connection_id || deps.connection.modelId !== input.model_id) throw new Error('运行连接与服务端绑定身份不一致');
  const config = { ...createLearningAssistantThreadConfig(input.conversation_id), recursionLimit: Number.MAX_SAFE_INTEGER, durability: 'sync' as const };
  const saved = await graph.getState(config);
  const prior = saved.values as Partial<AssistantState>;
  if (prior.input !== undefined) {
    if (prior.input.owner_id !== input.owner_id || prior.input.conversation_id !== input.conversation_id) throw new Error('Checkpoint 身份不匹配');
    if (prior.input.run_id === input.run_id && JSON.stringify(prior.input) !== JSON.stringify(input)) throw new Error('同一运行输入发生变化');
    if (prior.input.run_id !== input.run_id && input.message.turn_no <= prior.input.message.turn_no) throw new Error('过期运行不能覆盖会话最新 Checkpoint');
    if (saved.next.length > 0 && prior.input.run_id !== input.run_id) throw new Error('会话仍有未完成运行，不允许覆盖 Checkpoint');
    if (prior.activeRunId === input.run_id && saved.next.length === 0 && prior.response !== null) return saved.values as AssistantState;
  }
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
