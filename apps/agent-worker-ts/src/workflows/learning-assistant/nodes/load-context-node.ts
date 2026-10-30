/**
 * 学习助手本轮上下文准备节点。
 * 调用顺序：prepareAgent → 冷启动读取历史 → 合并当前用户消息/证据 → 重置本轮临时状态及换题状态。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import { LEARNING_ASSISTANT_STATE_VERSION, mergeMessages, type AssistantState, type ConversationMessage } from '../state.js';

/** 准备本轮临时状态；换题重置诊断与提示，重复运行不重复追加用户消息。 */
export async function prepareAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.activeRunId === state.input.run_id) return {};
  const changedQuestion = state.questionId !== state.input.question_id;
  const stalledTurns = changedQuestion || state.pendingQuestion === null ? 0 : state.stalledTurns + 1;
  const hintLevel = changedQuestion ? 0 : stalledTurns >= 2 ? Math.min(3, state.hintLevel + 1) : state.hintLevel;
  const initial = state.activeRunId === '' ? await deps.loadInitialMessages(state.input) : state.messages;
  const current: ConversationMessage = { id: state.input.message.id, turnNo: state.input.message.turn_no, role: 'user', content: state.input.message.content };
  const context = changedQuestion ? { facts: {}, evidence: [] } : state.context;
  const evidence = context.evidence.filter(/** 去掉当前消息的旧副本。 */ (item) => item.id !== current.id);
  // 冷启动时用历史用户消息建立证据；换题只接受当前新解释，防止把旧题表现沿用到新题。
  for (const message of initial) {
    if ((!changedQuestion || state.activeRunId === '') && message.role === 'user' && message.content !== null && !evidence.some(/** 防止历史证据重复。 */ (item) => item.id === message.id)) {
      evidence.push({ id: message.id, kind: 'user_message', source_id: message.id, content: message.content, turn_no: message.turnNo, executed: false });
    }
  }
  evidence.push({ id: current.id, kind: 'user_message', source_id: current.id, content: state.input.message.content, turn_no: current.turnNo, executed: false });
  return {
    stateVersion: LEARNING_ASSISTANT_STATE_VERSION,
    activeRunId: state.input.run_id, questionId: state.input.question_id,
    messages: mergeMessages(initial, [current]), context: { ...context, evidence },
    diagnosisText: changedQuestion ? null : state.diagnosisText,
    hintLevel, stalledTurns: stalledTurns >= 2 ? 0 : stalledTurns,
    pendingQuestion: changedQuestion ? null : state.pendingQuestion,
    verificationTarget: changedQuestion ? null : state.verificationTarget,
    intent: null, stage: changedQuestion ? 'context_loaded' : state.stage,
    responseText: null, tutorText: null, modelStep: 0, reactTurns: { main: 0, error_attribution: 0, socratic_tutor: 0 },
  };
}
