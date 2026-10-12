/**
 * 错题归因子 Agent：使用独立归因提示词与归因输出合同。
 * 调用顺序：runErrorAttributionAgent → 共用子模型循环 → parseAttributionOutput → 校验证据并返回归因结果。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import { AttributionSchema, type Attribution } from '../schemas/index.js';
import type { AssistantState } from '../state.js';
import { buildErrorAttributionPrompt } from '../prompts/error-attribution-prompt.js';
import { runChildModel } from './shared.js';

/** 校验归因输出；证据不足允许返回 insufficient_evidence，证据引用由共用循环校验。 */
function parseAttributionOutput(raw: unknown): Attribution {
  return AttributionSchema.parse(raw);
}

/** 执行归因子 Agent 的一个模型步骤，工具与恢复规则由共用循环保持一致。 */
export async function runErrorAttributionAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return await runChildModel(deps, state, 'error_attribution', buildErrorAttributionPrompt, parseAttributionOutput);
}
