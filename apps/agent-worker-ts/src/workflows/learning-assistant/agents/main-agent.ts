/**
 * 学习教练主 Agent：通过 LangChain ChatModel 产生单轮决策，由 LangGraph 路由只读工具和两个子 Agent。
 * 调用顺序：runMainAgent → 主模型单轮 Function Calling → State 写入工具调用或自然语言回复。
 */
import type { LearningAssistantDependencies } from '../ports.js';
import type { AssistantState } from '../state.js';
import { runMainAgentTurn } from './langchain-agent-runner.js';

/** 主 Agent 的独立模型节点；子 Agent 结果由图节点以 ToolMessage 直接回传。 */
export async function runMainAgent(deps: LearningAssistantDependencies, state: AssistantState): Promise<Partial<AssistantState>> {
  return await runMainAgentTurn(deps, state);
}
