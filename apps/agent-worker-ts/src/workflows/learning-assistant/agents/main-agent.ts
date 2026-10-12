/**
 * 学习教练主 Agent：自主工具路由与最终回复结构校验。
 * 调用顺序：runMainAgent → callModel（使用主提示词）→ 返回串行工具状态或主回复 → 一次非法输出修复。
 */
import type { ModelMessage } from '../../../infrastructure/llm/model-gateway.js';
import type { LearningAssistantDependencies } from '../ports.js';
import { MainResponseSchema } from '../schemas/index.js';
import { mergeMessages, recentModelMessages, type AssistantState } from '../state.js';
import { buildMainAgentPrompt } from '../prompts/main-agent-prompt.js';
import { buildValidationFeedback } from '../prompts/validation-feedback.js';
import { callModel, conversationMessage } from './shared.js';

/** 主 Agent 自行通过 Function Calling 路由；非法最终 JSON 仅修复一次。 */
export async function runMainAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  const { response, step } = await callModel(deps, state, 'main', [...recentModelMessages(state.messages, state.input.message.turn_no), ...state.repairMessages], state.mainRepairUsed, buildMainAgentPrompt);
  const message = conversationMessage(state, 'main:' + step, response.message);
  const pending = [...(response.message.toolCalls ?? [])];
  if (pending.length > 0) return { messages: mergeMessages(state.messages, [message]), modelStep: step, pending, toolIndex: 0, toolBatchStep: step };
  try {
    const output = MainResponseSchema.parse(JSON.parse(response.message.content ?? ''));
    // 最终助手消息在 persist 节点写自然语言，模型草稿仅进入完整轨迹。
    return { modelStep: step, pending: [], response: output, intent: output.intent, stage: output.stage };
  } catch (error) {
    if (state.mainRepairUsed) throw new Error('LEARNING_ASSISTANT_OUTPUT_INVALID：主 Agent 一次修复后仍非法', { cause: error });
    const feedback: ModelMessage = { role: 'user', content: buildValidationFeedback(error) };
    // 内部修复消息保留在 Checkpoint，不作为用户产品消息落库。
    return { repairMessages: [response.message, feedback], mainRepairUsed: true, modelStep: step, pending: [] };
  }
}
