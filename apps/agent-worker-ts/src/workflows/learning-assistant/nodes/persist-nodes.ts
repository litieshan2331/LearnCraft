/**
 * 学习助手自然语言消息与服务端控制状态的持久化节点。
 * 调用顺序：persistMainIntermediateMessages 同步工具链 → persistAgentResponse 保存自由文本回复。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import { mergeMessages, type AssistantState, type ConversationMessage } from '../state.js';
import { stableId } from '../agents/shared.js';

/** 写入主 Agent 产生的消息；子 Agent 内部消息只进入 Checkpoint 与观测。 */
async function saveMainMessages(deps: LearningAssistantDependencies, state: AssistantState, additions: ConversationMessage[]): Promise<ConversationMessage[]> {
  await deps.persistMessages(state.input, additions);
  return mergeMessages(state.messages, additions);
}

/** 模型和工具结果先进入 Checkpoint，再同步业务消息；写库失败不重跑已保存的 ReAct 步骤。 */
export async function persistMainIntermediateMessages(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const messages = state.messages.filter((message) => message.turnNo === state.input.message.turn_no && message.role !== 'user');
  if (messages.length > 0) await deps.persistMessages(state.input, messages);
  return {};
}

/** 保存自由文本回复；提示等级等控制状态只使用 State 中已有的服务端值。 */
export async function persistAgentResponse(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  if (state.responseText === null || state.responseText.trim().length === 0) throw new Error('缺少主回复');
  const message: ConversationMessage = { id: stableId(state.input.run_id + ':final'), turnNo: state.input.message.turn_no, role: 'assistant', content: state.responseText };
  return {
    messages: await saveMainMessages(deps, state, [message]),
  };
}
