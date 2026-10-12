/**
 * 学习助手消息与学习经历的持久化节点。
 * 调用顺序：persistMainIntermediateMessages → persistAgentResponse（固定ID/待回答问题/提示升级）→ persistAgentMemory（服务端校验后幂等写入）。
 */
import type { LearningAssistantDependencies, MemoryCandidate } from '../ports.js';
import { renderMainResponse } from '../schemas/index.js';
import { mergeMessages, type AssistantState, type ConversationMessage } from '../state.js';
import { conversationMessage } from '../agents/shared.js';

/** 写入主 Agent 产生的消息；子 Agent 内部消息只进入 Checkpoint 与观测。 */
async function saveMainMessages(deps: LearningAssistantDependencies, state: AssistantState, additions: ConversationMessage[]): Promise<ConversationMessage[]> {
  await deps.persistMessages(state.input, additions);
  return mergeMessages(state.messages, additions);
}

/** 模型/工具结果先进入 Checkpoint，再由独立节点同步业务消息；写库失败不重跑已保存模型或工具。 */
export async function persistMainIntermediateMessages(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const messages = state.messages.filter(/** 仅同步本轮已生成的助手及工具消息。 */ (message) => message.turnNo === state.input.message.turn_no && message.role !== 'user');
  if (messages.length > 0) await deps.persistMessages(state.input, messages);
  return {};
}

/** 完成本轮，自然语言消息固定 ID，保存待回答问题；连续两次无推进提高下轮提示级别。 */
export async function persistAgentResponse(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.response === null) throw new Error('缺少主回复');
  const verification = state.tutor?.verification ?? state.diagnosis?.verification;
  const hasUserPerformance = verification?.evidence_ids.some(/** 查找被引用的当前用户表现。 */ (id) => state.context.evidence.some(/** 排除仅口头确认的表现证据。 */ (e) => e.id === id && e.kind === 'user_message' && e.turn_no === state.input.message.turn_no && !/^(明白了|懂了|知道了|ok|好的)[。！!\s]*$/i.test(e.content.trim()))) ?? false;
  const progressed = verification?.demonstrated_progress === true && hasUserPerformance;
  const stalled = state.pendingQuestion === null ? 0 : progressed ? 0 : state.stalledTurns + 1;
  const hintLevel = stalled >= 2 ? Math.min(3, state.hintLevel + 1) : state.hintLevel;
  const message = conversationMessage(state, 'final', { role: 'assistant', content: renderMainResponse(state.response) });
  return { messages: await saveMainMessages(deps, state, [message]), pendingQuestion: state.response.primary_question, hintLevel, stalledTurns: stalled >= 2 ? 0 : stalled };
}

/** 验证来源与用户后续表现后再交服务端确认；未经实际执行只标为模型评估。 */
export async function persistAgentMemory(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.memoryWritten) return {};
  const verification = state.tutor?.verification ?? state.diagnosis?.verification;
  if (verification === undefined || verification.status === 'not_verified' || !verification.demonstrated_progress) return {};
  const evidence = state.context.evidence.filter(/** 提取验证结论实际引用的证据。 */ (item) => verification.evidence_ids.includes(item.id));
  const laterPerformance = evidence.some(/** 检查当前轮可观察的用户表现。 */ (item) => item.kind === 'user_message' && item.turn_no === state.input.message.turn_no && !/^(明白了|懂了|知道了|ok|好的)[。！!\s]*$/i.test(item.content.trim()));
  if (!laterPerformance || evidence.some(/** 外部网页不能验证用户修复。 */ (item) => item.kind === 'external_source')) return {};
  const executed = evidence.some(/** 识别本轮实际执行或测评证据。 */ (item) => item.executed && item.turn_no === state.input.message.turn_no && (item.kind === 'assessment_answer' || item.kind === 'tool_result'));
  const candidate: MemoryCandidate = {
    verification: { ...verification, status: executed ? verification.status : 'model_evaluated' },
    evidence, diagnosis: state.diagnosis, evaluation: executed ? 'executed' : 'model_evaluated',
  };
  if (!await deps.validateLearningMemory(state.input, candidate)) return {};
  await deps.persistLearningMemory(state.input, candidate);
  return { memoryWritten: true };
}
