/**
 * 学习助手主/子 Agent 的串行工具节点。
 * 调用顺序：runMainTool → 可信输入组装/子 Agent 委派 → runChildTool → 轨迹记录 → 返回已完成工具状态。
 */
import type { ModelToolCall } from '../../../infrastructure/llm/model-gateway.js';
import type { LearningAssistantDependencies } from '../ports.js';
import { ChildAgentInputSchema, DelegateInputSchema, type Actor, type Attribution, type SocraticResponse } from '../schemas/index.js';
import { mergeMessages, type AssistantState } from '../state.js';
import { DELEGATE_NAMES, executeReadTool, toolsForActor } from '../tools/index.js';
import { conversationMessage, stableId } from '../agents/shared.js';

/** 用同一工具 span 记录开始和完成，子模型以此为父级。 */
async function traceTool(deps: LearningAssistantDependencies, state: AssistantState, actor: Actor, call: ModelToolCall, span: string, completed: boolean, result?: unknown): Promise<void> {
  await deps.trace.append({
    runId: state.input.run_id, turnNo: state.input.message.turn_no,
    eventType: completed ? 'tool.completed' : 'tool.started', spanId: span,
    parentSpanId: actor === 'main' ? stableId(state.input.run_id) : state.child?.spanId ?? null,
    agentName: actor, payload: { toolName: call.name, toolCallId: call.id, argumentsJson: call.argumentsJson, ...(completed ? { result } : {}) },
  });
}

/** 完成一个主工具并把结构化结果返回主消息链；串行游标独立保存。 */
async function finishMainTool(deps: LearningAssistantDependencies, state: AssistantState, call: ModelToolCall, result: unknown): Promise<Partial<AssistantState>> {
  const span = stableId(state.input.run_id + ':tool:' + state.toolBatchStep + ':' + state.toolIndex + ':' + call.id);
  await traceTool(deps, state, 'main', call, span, true, result);
  const message = conversationMessage(state, 'tool:' + span, { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
  return { messages: mergeMessages(state.messages, [message]), toolIndex: state.toolIndex + 1, child: null };
}

/** 执行单个读工具；参数错误作为明确工具错误返回，数据库/出网端口失败由图抛出。 */
async function readTool(deps: LearningAssistantDependencies, state: AssistantState, actor: Actor, call: ModelToolCall) {
  if (!toolsForActor(actor).some(/** 检查角色的读工具白名单。 */ (tool) => tool.name === call.name) || DELEGATE_NAMES.some(/** 读工具通道拒绝委派。 */ (name) => name === call.name)) {
    return { result: { ok: false, code: 'TOOL_NOT_ALLOWED', message: '当前 Agent 不允许调用该工具' }, context: state.context };
  }
  try { return await executeReadTool(deps, state, call); }
  catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
      return { result: { ok: false, code: 'TOOL_ARGUMENTS_INVALID', message: '工具参数不符合合同，不允许指定用户或题目身份' }, context: state.context };
    }
    throw error;
  }
}

/** 主工具顺序执行；子 Agent 不接收模型伪造的题目或画像参数。 */
export async function runMainTool(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const call = state.pending[state.toolIndex];
  if (call === undefined) return {};
  const span = stableId(state.input.run_id + ':tool:' + state.toolBatchStep + ':' + state.toolIndex + ':' + call.id);
  if (state.child?.result != null) {
    const output = state.child.result;
    const update = await finishMainTool(deps, state, call, { ok: true, data: output });
    return { ...update, ...(state.child.actor === 'error_attribution' ? { diagnosis: output as Attribution } : { tutor: output as SocraticResponse, hintLevel: (output as SocraticResponse).hint_level, verificationTarget: (output as SocraticResponse).next_verification_target }) };
  }
  await traceTool(deps, state, 'main', call, span, false);
  if (DELEGATE_NAMES.some(/** 识别主 Agent 的子 Agent 委派工具。 */ (name) => name === call.name)) {
    let task: string;
    try { task = DelegateInputSchema.parse(JSON.parse(call.argumentsJson)).task; }
    catch { return await finishMainTool(deps, state, call, { ok: false, code: 'DELEGATE_ARGUMENTS_INVALID', message: '只能传 task；相关事实由服务端组装' }); }
    const actor = call.name === 'analyze_wrong_answer' ? 'error_attribution' : 'socratic_tutor';
    const recentTurns = new Set([...new Set(state.messages.map(/** 提取消息所属轮次。 */ (message) => message.turnNo))].sort(/** 轮次升序。 */ (a, b) => a - b).slice(-20));
    const trustedInput = ChildAgentInputSchema.parse({
      requested_task: task, user_explanation: state.input.message.content,
      wrong_question: state.context.facts.get_wrong_question ?? null,
      user_profile: state.context.facts.get_user_profile ?? null,
      mastery_state: state.context.facts.get_mastery_state ?? null,
      learning_context: state.context.facts.get_learning_context ?? null,
      diagnosis: state.diagnosis,
      evidence: state.context.evidence.filter(/** 子 Agent 只获得近期及业务证据。 */ (item) => item.turn_no === null || recentTurns.has(item.turn_no)),
      hint_level: state.hintLevel, pending_question: state.pendingQuestion,
      next_verification_target: state.verificationTarget,
    });
    return { child: { actor, spanId: span, messages: [{ role: 'user', content: JSON.stringify(trustedInput) }], pending: [], index: 0, toolBatchStep: 0, repairUsed: false, result: null } };
  }
  let output: Awaited<ReturnType<typeof readTool>>;
  try { output = await readTool(deps, state, 'main', call); }
  catch (error) {
    await traceTool(deps, state, 'main', call, span, true, { ok: false, code: 'TOOL_EXECUTION_FAILED', message: '工具执行失败；运行从当前工具节点恢复' });
    throw error;
  }
  return { ...await finishMainTool(deps, state, call, output.result), context: output.context };
}

/** 一次只运行一个子工具；其消息留在子状态，父图只接收结构化结果。 */
export async function runChildTool(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const child = state.child;
  if (child === null) throw new Error('缺少子 Agent 状态');
  const call = child.pending[child.index];
  if (call === undefined) return {};
  const span = stableId(child.spanId + ':tool:' + child.toolBatchStep + ':' + child.index + ':' + call.id);
  await traceTool(deps, state, child.actor, call, span, false);
  let output: Awaited<ReturnType<typeof readTool>>;
  try { output = await readTool(deps, state, child.actor, call); }
  catch (error) {
    await traceTool(deps, state, child.actor, call, span, true, { ok: false, code: 'TOOL_EXECUTION_FAILED', message: '子工具执行失败；运行从当前工具节点恢复' });
    throw error;
  }
  await traceTool(deps, state, child.actor, call, span, true, output.result);
  return { context: output.context, child: { ...child, index: child.index + 1, messages: [...child.messages, { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(output.result) }] } };
}
