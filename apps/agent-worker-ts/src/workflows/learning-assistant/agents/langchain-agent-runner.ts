/**
 * 学习助手 LangGraph ReAct Agent runner。
 * 调用顺序：构造角色模型和白名单工具 → 主 Agent 委派子 Agent → LangGraph ReAct 循环 → 返回消息、上下文和控制结果。
 * 子 Agent 失败通过 ChildAgentInvocationError 回到主 Agent；本文件不把失败伪装成结构化成功结果。
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import type { ModelToolCall, ModelToolDefinition } from '../../../infrastructure/llm/model-gateway.js';
import type { LearningAssistantDependencies } from '../ports.js';
import { ChildAgentInputSchema, DelegateInputSchema } from '../schemas/index.js';
import { buildMainAgentPrompt } from '../prompts/main-agent-prompt.js';
import { buildErrorAttributionPrompt } from '../prompts/error-attribution-prompt.js';
import { buildSocraticTutorPrompt } from '../prompts/socratic-tutor-prompt.js';
import { executeReadTool, toolsForActor } from '../tools/index.js';
import { mergeMessages, recentModelMessages, type AssistantState, type ConversationMessage, type TrustedContext } from '../state.js';
import { reactLimitExceeded, scopedTrace, stableId } from './shared.js';
import { LearningAssistantChatModel, toModelMessage } from './langchain-model-adapter.js';

/** 子 Agent 调用失败的稳定错误；主 Agent 可根据 retryable 决策重试或降级。 */
export class ChildAgentInvocationError extends Error {
  readonly retryable: boolean;
  constructor(readonly actor: 'error_attribution' | 'socratic_tutor', readonly phase: string, readonly code: string, retryable: boolean) {
    super('子 Agent ' + actor + ' 在 ' + phase + ' 阶段失败：' + code);
    this.name = 'ChildAgentInvocationError';
    this.retryable = retryable;
  }
}

type ChildResult = { text: string };
type AgentActor = 'main' | 'error_attribution' | 'socratic_tutor';
type MutableRun = { modelStep: number; reactTurns: AssistantState['reactTurns']; context: TrustedContext; child: Partial<Record<'error_attribution' | 'socratic_tutor', ChildResult>>; intent: AssistantState['intent']; stage: AssistantState['stage'] };

const looseInput = z.record(z.string(), z.unknown());

/** LangChain 消息转成带稳定 ID 的业务消息，供父图保存和恢复。 */
function generatedMessages(state: AssistantState, messages: readonly BaseMessage[], initialLength: number): ConversationMessage[] {
  return messages.slice(initialLength).filter((message) => !(message instanceof SystemMessage)).map((message, index) => ({
    ...toModelMessage(message),
    id: stableId(state.input.run_id + ':langchain:' + String(state.modelStep + index + 1)),
    turnNo: state.input.message.turn_no,
  }));
}

/** 取得当前角色的提示词并过滤与该角色无关的工具。 */
function promptFor(state: AssistantState, actor: AgentActor, deps: LearningAssistantDependencies): string {
  const skills = deps.skills.listSkills().filter((skill) => skill.workflows.includes('learning_assistant')).map((skill) => ({ id: skill.id, title: skill.title, summary: skill.summary }));
  return actor === 'main' ? buildMainAgentPrompt(state, skills) : actor === 'error_attribution' ? buildErrorAttributionPrompt(state, skills) : buildSocraticTutorPrompt(state, skills);
}

/** 将项目工具定义包装为 LangChain 工具；状态更新留在 runner 的可变引用中。 */
function createReadTools(deps: LearningAssistantDependencies, state: AssistantState, actor: Exclude<AgentActor, 'main'> | 'main', run: MutableRun) {
  return toolsForActor(actor).filter((definition) => !['analyze_wrong_answer', 'generate_socratic_question'].includes(definition.name)).map((definition: ModelToolDefinition) => tool(async (args) => {
    const call: ModelToolCall = { id: stableId(state.input.run_id + ':langchain-tool:' + actor + ':' + definition.name + ':' + String(run.modelStep)), name: definition.name, argumentsJson: JSON.stringify(args) };
    const spanId = call.id;
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.started', spanId, parentSpanId: stableId(state.input.run_id), agentName: actor, payload: { toolName: definition.name, toolCallId: call.id } });
    try {
      const output = await executeReadTool(deps, { ...state, context: run.context }, call);
      run.context = output.context;
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId, parentSpanId: stableId(state.input.run_id), agentName: actor, payload: { toolName: definition.name, toolCallId: call.id, ok: true } });
      return JSON.stringify(output.result);
    } catch (error) {
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId, parentSpanId: stableId(state.input.run_id), agentName: actor, payload: { toolName: definition.name, toolCallId: call.id, ok: false, code: 'TOOL_ARGUMENTS_INVALID' } });
      return JSON.stringify({ ok: false, code: 'TOOL_ARGUMENTS_INVALID', message: '工具参数不符合要求' });
    }
  }, { name: definition.name, description: definition.description, schema: looseInput }));
}

/** 构造带调用次数限制和嵌套轨迹的 LangChain 模型。 */
function createModel(deps: LearningAssistantDependencies, state: AssistantState, actor: AgentActor, run: MutableRun): LearningAssistantChatModel {
  const limit = deps.reactLimits[actor];
  return new LearningAssistantChatModel(deps.model, {
    agentRunId: state.input.run_id,
    turnNo: state.input.message.turn_no,
    connection: deps.connection,
    beforeModelAttempt: async () => {
      const next = run.reactTurns[actor] + 1;
      if (next > limit) throw reactLimitExceeded(actor, limit);
      await deps.reserveModelAttempt(state.input);
      run.reactTurns = { ...run.reactTurns, [actor]: next };
      run.modelStep += 1;
    },
    traceWriter: scopedTrace(deps, actor, stableId(state.input.run_id + ':model:' + String(run.modelStep + 1)), stableId(state.input.run_id)),
  });
}

/** 调用子 Agent；失败统一转换成可由主 Agent 感知的异常。 */
async function invokeChildAgent(deps: LearningAssistantDependencies, state: AssistantState, actor: Exclude<AgentActor, 'main'>, task: string, run: MutableRun): Promise<ChildResult> {
  try {
    const trustedInput = ChildAgentInputSchema.parse({
      requested_task: task,
      user_explanation: state.input.message.content,
      wrong_question: run.context.facts.get_wrong_question ?? null,
      user_profile: run.context.facts.get_user_profile ?? null,
      mastery_state: run.context.facts.get_mastery_state ?? null,
      diagnosis_text: state.diagnosisText,
      evidence: run.context.evidence,
      hint_level: state.hintLevel,
      pending_question: state.pendingQuestion,
      next_verification_target: state.verificationTarget,
    });
    const childRun: MutableRun = { modelStep: run.modelStep, reactTurns: run.reactTurns, context: run.context, child: {}, intent: state.intent, stage: state.stage };
    const childModel = createModel(deps, state, actor, childRun);
    const childTools = createChildTools(deps, state, actor, childRun);
    const childAgent = createReactAgent({ llm: childModel, tools: childTools, prompt: promptFor(state, actor, deps), version: 'v1', checkpointer: deps.checkpointer });
    const input = { messages: [new HumanMessage(JSON.stringify(trustedInput))] };
    const result = await childAgent.invoke(input, { configurable: { thread_id: state.input.run_id + ':child:' + actor } });
    run.modelStep = childRun.modelStep; run.reactTurns = childRun.reactTurns; run.context = childRun.context;
    const last = [...result.messages].reverse().find((message) => message instanceof AIMessage);
    if (last === undefined) throw new Error('子 Agent 未返回助手消息');
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const parsed: ChildResult = { text };
    run.child[actor] = parsed;
    return parsed;
  } catch (error) {
    if (error instanceof ChildAgentInvocationError) throw error;
    const retryable = typeof error === 'object' && error !== null && 'retryable' in error && (error as { retryable?: unknown }).retryable === true;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : error instanceof Error ? error.name : 'UNKNOWN';
    throw new ChildAgentInvocationError(actor, 'invoke', code, retryable);
  }
}

/** 创建主 Agent 的业务和子 Agent 委派工具。 */
function createMainTools(deps: LearningAssistantDependencies, state: AssistantState, run: MutableRun) {
  const readTools = createReadTools(deps, state, 'main', run);
  const delegates = (['analyze_wrong_answer', 'generate_socratic_question'] as const).map((name) => tool(async (args) => {
    const validation = DelegateInputSchema.safeParse(args);
    if (!validation.success) return JSON.stringify({ ok: false, code: 'TOOL_ARGUMENTS_INVALID', message: '委派参数不符合要求' });
    const actor = name === 'analyze_wrong_answer' ? 'error_attribution' : 'socratic_tutor';
    run.intent = actor === 'error_attribution' ? 'wrong_answer_analysis' : 'socratic_followup';
    run.stage = actor === 'error_attribution' ? 'diagnosing' : 'waiting_for_user';
    const spanId = stableId(state.input.run_id + ':delegate:' + name + ':' + String(run.modelStep));
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.started', spanId, parentSpanId: stableId(state.input.run_id), agentName: 'main', payload: { toolName: name, toolCallId: spanId } });
    try {
      const result = await invokeChildAgent(deps, { ...state, context: run.context }, actor, validation.data.task, run);
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId, parentSpanId: stableId(state.input.run_id), agentName: 'main', payload: { toolName: name, toolCallId: spanId, ok: true } });
      return JSON.stringify(result);
    } catch (error) {
      if (!(error instanceof ChildAgentInvocationError)) throw error;
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId, parentSpanId: stableId(state.input.run_id), agentName: 'main', payload: { toolName: name, toolCallId: spanId, ok: false, code: 'CHILD_AGENT_FAILED' } });
      throw error;
    }
  }, { name, description: name === 'analyze_wrong_answer' ? '委派错题归因子 Agent。' : '委派苏格拉底导师子 Agent。', schema: looseInput }));
  return [...readTools, ...delegates];
}

/** 子 Agent 只获得只读工具；委派工具不注册，因此无法递归或交叉调用。 */
function createChildTools(deps: LearningAssistantDependencies, state: AssistantState, actor: Exclude<AgentActor, 'main'>, run: MutableRun) {
  return createReadTools(deps, state, actor, run);
}

/** 执行主 Agent ReAct，并把子结果写入父图 State。 */
export async function runLangChainMainAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const run: MutableRun = { modelStep: state.modelStep, reactTurns: state.reactTurns, context: state.context, child: {}, intent: state.intent, stage: state.stage };
  const initial = recentMessagesAsLangChain(state);
  const model = createModel(deps, state, 'main', run);
  const agent = createReactAgent({ llm: model, tools: createMainTools(deps, state, run), prompt: promptFor(state, 'main', deps), version: 'v1', checkpointer: deps.checkpointer });
  const result = await agent.invoke({ messages: initial }, { configurable: { thread_id: state.input.run_id + ':main' } });
  const last = [...result.messages].reverse().find((message) => message instanceof AIMessage);
  if (last === undefined || typeof last.content !== 'string') throw new Error('主 Agent 未返回最终自然语言消息');
  const responseText = last.content;
  const tutorResult = run.child.socratic_tutor;
  const diagnosisResult = run.child.error_attribution;
  return {
    // 最终自然语言由 persistAgentResponse 以固定 final ID 写入；中间节点只同步工具调用链。
    messages: mergeMessages(state.messages, generatedMessages(state, result.messages, initial.length).filter((message) => message.role !== 'assistant' || (message.toolCalls?.length ?? 0) > 0)),
    context: run.context,
    responseText,
    intent: run.intent,
    stage: run.stage,
    diagnosisText: diagnosisResult?.text ?? state.diagnosisText,
    tutorText: tutorResult?.text ?? state.tutorText,
    pendingQuestion: state.pendingQuestion,
    hintLevel: state.hintLevel,
    verificationTarget: state.verificationTarget,
    modelStep: run.modelStep,
    reactTurns: run.reactTurns,
  };
}

/** 将最近模型窗口转换为 LangChain 输入，业务消息 ID 仍由父 State 保存。 */
function recentMessagesAsLangChain(state: AssistantState): BaseMessage[] {
  return recentModelMessages(state.messages, state.input.message.turn_no).map((message) => {
    if (message.role === 'user') return new HumanMessage(message.content ?? '');
    if (message.role === 'tool') return new HumanMessage(JSON.stringify(message));
    return new AIMessage({ content: message.content ?? '', ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, args: safeJson(call.argumentsJson) })) }) });
  });
}

/** 工具参数转换失败时不让历史消息破坏当前 Agent 输入。 */
function safeJson(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

