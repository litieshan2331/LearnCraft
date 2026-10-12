/**
 * 苏格拉底导师子 Agent：使用独立导师提示词、单问题输出与提示级别校验。
 * 调用顺序：runSocraticTutorAgent → 共用子模型循环 → parseSocraticOutput → 校验证据并返回提问/验证目标。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import { SocraticSchema, type SocraticResponse } from '../schemas/index.js';
import type { AssistantState } from '../state.js';
import { buildSocraticTutorPrompt } from '../prompts/socratic-tutor-prompt.js';
import { runChildModel } from './shared.js';

/** 校验导师输出及提示级别，防止低于服务端已确定的提示等级。 */
function parseSocraticOutput(raw: unknown, state: AssistantState): SocraticResponse {
  const output = SocraticSchema.parse(raw);
  if (output.hint_level < state.hintLevel) throw new Error('提示级别不能低于服务端当前级别');
  return output;
}

/** 执行导师子 Agent 的一个模型步骤，工具与恢复规则由共用循环保持一致。 */
export async function runSocraticTutorAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return await runChildModel(deps, state, 'socratic_tutor', buildSocraticTutorPrompt, parseSocraticOutput);
}
