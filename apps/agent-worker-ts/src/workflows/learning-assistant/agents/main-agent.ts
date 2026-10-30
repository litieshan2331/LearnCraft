/**
 * 学习教练主 Agent：通过 LangChain ReAct 路由只读工具和两个子 Agent。
 * 调用顺序：runMainAgent → LangChain ChatModel/Tool 循环 → State 写入自然语言回复和控制状态。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import type { AssistantState } from '../state.js';
import { runLangChainMainAgent } from './langchain-agent-runner.js';

/** 主 Agent 通过 LangChain ReAct 和委派工具路由；子 Agent 结果与控制状态回写父图 State。 */
export async function runMainAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return await runLangChainMainAgent(deps, state);
}
