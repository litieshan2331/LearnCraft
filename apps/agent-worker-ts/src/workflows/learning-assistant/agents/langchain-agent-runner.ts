/**
 * 学习助手三个独立 Agent 的 LangChain 适配与单轮执行。
 * 调用顺序：主 Agent 单轮决策 → 图路由只读工具或固定子 Agent → 子 Agent 结果绑定原 tool_call_id 回到主 Agent。
 * 子 Agent 的自然语言不做语义校验；只校验工具调用关联字段、白名单和服务端控制状态。
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ModelToolCall, ModelToolDefinition } from '../../../infrastructure/llm/model-gateway.js';
import type { LearningAssistantDependencies } from '../ports.js';
import { ChildAgentInputSchema, DelegateInputSchema } from '../schemas/index.js';
import { buildMainAgentPrompt } from '../prompts/main-agent-prompt.js';
import { buildErrorAttributionPrompt } from '../prompts/error-attribution-prompt.js';
import { buildSocraticTutorPrompt } from '../prompts/socratic-tutor-prompt.js';
import { executeReadTool, toolsForActor } from '../tools/index.js';
import { mergeMessages, recentModelMessages, type AssistantState, type ConversationMessage, type DelegationState, type TrustedContext } from '../state.js';
import { reactLimitExceeded, scopedTrace, stableId } from './shared.js';
import { LearningAssistantChatModel, toModelMessage } from './langchain-model-adapter.js';

/** 子 Agent 失败的脱敏错误；图节点会把它转换为主 Agent 的工具结果。 */
export class ChildAgentInvocationError extends Error {
  readonly retryable: boolean;
  constructor(readonly actor: 'error_attribution' | 'socratic_tutor', readonly phase: string, readonly code: string, retryable: boolean) {
    super('子 Agent ' + actor + ' 在 ' + phase + ' 阶段失败：' + code);
    this.name = 'ChildAgentInvocationError';
    this.retryable = retryable;
  }
}

type AgentName = 'main' | 'error_attribution' | 'socratic_tutor';
type MutableRun = { modelStep: number; reactTurns: AssistantState['reactTurns']; context: TrustedContext; intent: AssistantState['intent']; stage: AssistantState['stage'] };
const looseInput = z.record(z.string(), z.unknown());

function skillSummaries(deps: LearningAssistantDependencies) {
  return deps.skills.listSkills().filter((skill) => skill.workflows.includes('learning_assistant')).map((skill) => ({ id: skill.id, title: skill.title, summary: skill.summary }));
}

function createAgentModel(deps: LearningAssistantDependencies, state: AssistantState, agent: AgentName, run: MutableRun, parentSpanId = stableId(state.input.run_id)): LearningAssistantChatModel {
  const limit = deps.reactLimits[agent];
  return new LearningAssistantChatModel(deps.model, {
    agentRunId: state.input.run_id,
    turnNo: state.input.message.turn_no,
    connection: deps.connection,
    beforeModelAttempt: async () => {
      const next = run.reactTurns[agent] + 1;
      if (next > limit) throw reactLimitExceeded(agent, limit);
      await deps.reserveModelAttempt(state.input);
      run.reactTurns = { ...run.reactTurns, [agent]: next };
      run.modelStep += 1;
    },
    traceWriter: scopedTrace(deps, agent, stableId(state.input.run_id + ':model:' + agent + ':' + String(run.modelStep + 1)), parentSpanId),
    onContentDelta: agent === 'main' ? (text) => deps.progress?.report('answer.delta', { turn: state.input.message.turn_no, text }) : undefined,
  });
}

function createReadTools(deps: LearningAssistantDependencies, state: AssistantState, agent: Exclude<AgentName, 'main'> | 'main', run: MutableRun, parentSpanId = stableId(state.input.run_id)) {
  return toolsForActor(agent).filter((definition) => !['analyze_wrong_answer', 'generate_socratic_question'].includes(definition.name)).map((definition: ModelToolDefinition) => tool(async (args) => {
    const call: ModelToolCall = { id: stableId(state.input.run_id + ':tool:' + agent + ':' + definition.name + ':' + String(run.modelStep)), name: definition.name, argumentsJson: JSON.stringify(args) };
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.started', spanId: call.id, parentSpanId, agentName: agent, payload: { toolName: definition.name, toolCallId: call.id } });
    try {
      const output = await executeReadTool(deps, { ...state, context: run.context }, call);
      run.context = output.context;
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: call.id, parentSpanId, agentName: agent, payload: { toolName: definition.name, toolCallId: call.id, ok: true, result: output.result } });
      return JSON.stringify(output.result);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'TOOL_ARGUMENTS_INVALID';
      await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: call.id, parentSpanId, agentName: agent, payload: { toolName: definition.name, toolCallId: call.id, ok: false, code } });
      return JSON.stringify({ ok: false, code: 'TOOL_ARGUMENTS_INVALID', message: '工具参数不符合要求' });
    }
  }, { name: definition.name, description: definition.description, schema: looseInput }));
}

function toConversationMessage(state: AssistantState, message: BaseMessage, suffix: string): ConversationMessage {
  const converted = toModelMessage(message);
  return { ...converted, id: stableId(state.input.run_id + ':' + suffix), turnNo: state.input.message.turn_no };
}

function toModelMessages(state: AssistantState): BaseMessage[] {
  return recentModelMessages(state.messages, state.input.message.turn_no).map((message) => {
    if (message.role === 'user') return new HumanMessage(message.content ?? '');
    if (message.role === 'tool') return new ToolMessage({ content: message.content ?? '', tool_call_id: message.toolCallId ?? '', name: message.name ?? undefined });
    return new AIMessage({ content: message.content ?? '', ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, args: safeJson(call.argumentsJson) })) }) });
  });
}

function toolCallsFrom(message: AIMessage): ModelToolCall[] {
  return (message.tool_calls ?? []).map((call) => ({ id: call.id ?? '', name: call.name, argumentsJson: JSON.stringify(call.args) }));
}

/** 主 Agent 单轮决策；工具调用交由 LangGraph 节点处理。 */
export async function runMainAgentTurn(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.pendingMainToolCalls.length > 0) {
    const nextCall = state.pendingMainToolCalls[0];
    if (!nextCall) return { delegation: null, responseText: null };
    const isDelegate = nextCall.name === 'analyze_wrong_answer' || nextCall.name === 'generate_socratic_question';
    return { delegation: isDelegate ? delegationFrom(nextCall) : null, responseText: null, ...delegationControl(nextCall.name) };
  }
  const run: MutableRun = { modelStep: state.modelStep, reactTurns: state.reactTurns, context: state.context, intent: state.intent, stage: state.stage };
  const model = createAgentModel(deps, state, 'main', run).bindTools(toolsForActor('main'));
  const message = await model.invoke([new SystemMessage(buildMainAgentPrompt(state, skillSummaries(deps))), ...toModelMessages(state)]);
  if (!(message instanceof AIMessage)) throw new Error('主 Agent 未返回助手消息');
  const toolCalls = toolCallsFrom(message);
  const generated = toConversationMessage(state, message, 'main:' + String(run.modelStep));
  const firstToolCall = toolCalls[0];
  const delegation = firstToolCall && (firstToolCall.name === 'analyze_wrong_answer' || firstToolCall.name === 'generate_socratic_question')
    ? delegationFrom(firstToolCall)
    : null;
  const responseText = toolCalls.length === 0 && typeof message.content === 'string' ? message.content : null;
  return {
    messages: mergeMessages(state.messages, responseText === null ? [generated] : []),
    pendingMainToolCalls: toolCalls,
    delegation,
    ...delegationControl(firstToolCall?.name),
    responseText,
    context: run.context,
    intent: run.intent,
    stage: run.stage,
    modelStep: run.modelStep,
    reactTurns: run.reactTurns,
  };
}

/** 委派是服务端控制状态的边界；模型自然语言不能直接改写阶段。 */
function delegationControl(name: string | undefined): Partial<Pick<AssistantState, 'intent' | 'stage'>> {
  if (name === 'analyze_wrong_answer') return { intent: 'wrong_answer_analysis', stage: 'diagnosing' };
  if (name === 'generate_socratic_question') return { intent: 'socratic_followup', stage: 'waiting_for_user' };
  return {};
}

function delegationFrom(call: ModelToolCall): DelegationState {
  const parsed = DelegateInputSchema.safeParse(safeJson(call.argumentsJson));
  const target = call.name === 'analyze_wrong_answer' ? 'error_attribution' : 'socratic_tutor';
  if (!call.id) throw new Error('委派工具调用缺少 tool_call_id');
  if (!parsed.success) return { toolCallId: call.id, target, task: '', status: 'failed', resultText: null, errorCode: 'TOOL_ARGUMENTS_INVALID' };
  return { toolCallId: call.id, target, task: parsed.data.task, status: 'requested', resultText: null, errorCode: null };
}

/** 主 Agent 的只读工具节点；完成后直接回到主 Agent。 */
export async function runMainReadTool(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const call = state.pendingMainToolCalls[0];
  if (!call || call.name === 'analyze_wrong_answer' || call.name === 'generate_socratic_question') return {};
  const toolSpanId = stableId(state.input.run_id + ':tool-span:' + call.id);
  const parentSpanId = stableId(state.input.run_id);
  await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.started', spanId: toolSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: call.id } });
  let content: string;
  let context = state.context;
  try {
    const output = await executeReadTool(deps, state, call);
    content = JSON.stringify(output.result);
    context = output.context;
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: toolSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: call.id, ok: true, result: output.result } });
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'TOOL_EXECUTION_FAILED';
    content = JSON.stringify({ ok: false, code, message: '工具调用失败，主 Agent 可根据已有信息继续处理。' });
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: toolSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: call.id, ok: false, code } });
  }
  const result: ConversationMessage = { id: stableId(state.input.run_id + ':tool-result:' + call.id + ':' + String(state.modelStep)), turnNo: state.input.message.turn_no, role: 'tool', content, toolCallId: call.id, name: call.name };
  return { messages: mergeMessages(state.messages, [result]), context, pendingMainToolCalls: state.pendingMainToolCalls.slice(1) };
}

type ChildAgentDefinition = {
  name: 'error_attribution' | 'socratic_tutor';
  prompt: string;
  createTools(run: MutableRun): ReturnType<typeof createReadTools>;
};

async function runChildAgent(deps: LearningAssistantDependencies, state: AssistantState, definition: ChildAgentDefinition): Promise<Partial<AssistantState>> {
  const delegation = state.delegation;
  if (!delegation || delegation.target !== definition.name) return {};
  const call = state.pendingMainToolCalls.find((item) => item.id === delegation.toolCallId);
  if (!call) throw new Error('委派工具调用与 State 的 tool_call_id 不匹配');
  const expectedToolName = definition.name === 'error_attribution' ? 'analyze_wrong_answer' : 'generate_socratic_question';
  if (call.name !== expectedToolName) throw new Error('委派目标与工具调用名称不匹配');
  const delegationSpanId = stableId(state.input.run_id + ':delegation:' + delegation.toolCallId);
  const parentSpanId = stableId(state.input.run_id);
  await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.started', spanId: delegationSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: delegation.toolCallId } });
  if (delegation.status === 'failed') {
    const result: ConversationMessage = { id: stableId(state.input.run_id + ':tool-result:' + delegation.toolCallId + ':' + String(state.modelStep)), turnNo: state.input.message.turn_no, role: 'tool', content: JSON.stringify({ ok: false, code: delegation.errorCode ?? 'TOOL_ARGUMENTS_INVALID', message: '委派参数不符合要求。' }), toolCallId: delegation.toolCallId, name: call.name };
    await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: delegationSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: delegation.toolCallId, ok: false, code: delegation.errorCode ?? 'TOOL_ARGUMENTS_INVALID' } });
    return { messages: mergeMessages(state.messages, [result]), pendingMainToolCalls: state.pendingMainToolCalls.filter((item) => item.id !== delegation.toolCallId) };
  }
  const childRun: MutableRun = { modelStep: state.modelStep, reactTurns: state.reactTurns, context: state.context, intent: state.intent, stage: state.stage };
  const childConfig = { configurable: { thread_id: stableId(state.input.run_id + ':' + definition.name + ':' + delegation.toolCallId) } };
  let resultText: string;
  let errorCode: string | null = null;
  let status: DelegationState['status'] = 'succeeded';
  try {
    const trustedInput = ChildAgentInputSchema.parse({ requested_task: delegation.task, user_explanation: state.input.message.content, wrong_question: state.context.facts.get_wrong_question ?? null, user_profile: state.context.facts.get_user_profile ?? null, mastery_state: state.context.facts.get_mastery_state ?? null, diagnosis_text: state.diagnosisText, evidence: state.context.evidence, hint_level: state.hintLevel, pending_question: state.pendingQuestion, next_verification_target: state.verificationTarget });
    const childModel = createAgentModel(deps, state, definition.name, childRun, delegationSpanId);
    const childAgent = createReactAgent({ llm: childModel, tools: definition.createTools(childRun), prompt: definition.prompt, version: 'v1', checkpointer: deps.checkpointer });
    const childSaved = await childAgent.getState(childConfig);
    const savedMessages = childSaved.values.messages as BaseMessage[] | undefined;
    const savedLast = savedMessages?.at(-1);
    const completedResult = savedLast instanceof AIMessage && (savedLast.tool_calls?.length ?? 0) === 0
      ? savedLast
      : null;
    const result = completedResult
      ? { messages: savedMessages! }
      : await childAgent.invoke(
        childSaved.next.length > 0 ? null : { messages: [new HumanMessage(JSON.stringify(trustedInput))] },
        childConfig,
      );
    const last = [...result.messages].reverse().find((message) => message instanceof AIMessage);
    if (!last) throw new Error('CHILD_AGENT_EMPTY_RESULT');
    resultText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  } catch (error) {
    status = 'failed';
    errorCode = error instanceof ChildAgentInvocationError ? error.code : errorCodeOf(error);
    resultText = '子 Agent ' + definition.name + ' 调用失败：' + errorCode;
  }
  await deps.trace.append({ runId: state.input.run_id, eventType: 'tool.completed', spanId: delegationSpanId, parentSpanId, agentName: 'main', payload: { toolName: call.name, toolCallId: delegation.toolCallId, ok: status === 'succeeded', ...(status === 'succeeded' ? { result: resultText } : { code: errorCode }) } });
  const toolResult: ConversationMessage = { id: stableId(state.input.run_id + ':tool-result:' + delegation.toolCallId + ':' + String(state.modelStep)), turnNo: state.input.message.turn_no, role: 'tool', content: resultText, toolCallId: delegation.toolCallId, name: call.name };
  const nextDelegation: DelegationState = { ...delegation, status, resultText: status === 'succeeded' ? resultText : null, errorCode };
  return {
    messages: mergeMessages(state.messages, [toolResult]),
    pendingMainToolCalls: state.pendingMainToolCalls.filter((item) => item.id !== delegation.toolCallId),
    delegation: nextDelegation,
    diagnosisText: definition.name === 'error_attribution' && status === 'succeeded' ? resultText : state.diagnosisText,
    tutorText: definition.name === 'socratic_tutor' && status === 'succeeded' ? resultText : state.tutorText,
    modelStep: childRun.modelStep,
    reactTurns: childRun.reactTurns,
    context: childRun.context,
  };
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

/** 固定的错题归因 Agent 节点。 */
export function runErrorAttributionAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return runChildAgent(deps, state, {
    name: 'error_attribution',
    prompt: buildErrorAttributionPrompt(state, skillSummaries(deps)),
    createTools: (run) => createReadTools(deps, state, 'error_attribution', run, stableId(state.input.run_id + ':delegation:' + state.delegation?.toolCallId)),
  });
}

/** 固定的苏格拉底导师 Agent 节点。 */
export function runSocraticTutorAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return runChildAgent(deps, state, {
    name: 'socratic_tutor',
    prompt: buildSocraticTutorPrompt(state, skillSummaries(deps)),
    createTools: (run) => createReadTools(deps, state, 'socratic_tutor', run, stableId(state.input.run_id + ':delegation:' + state.delegation?.toolCallId)),
  });
}

function safeJson(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

/** 兼容旧调用方；新图使用 runMainAgentTurn。 */
export const runLangChainMainAgent = runMainAgentTurn;
