/**
 * 学习助手三个 Agent 的统一出口；三个角色均由 LangChain runner 装配。
 * 调用顺序：主 Agent 注册委派工具 → 子 Agent 使用只读工具 → 返回自然语言结果。
 */
export { runMainAgent } from './main-agent.js';
export { ChildAgentInvocationError } from './langchain-agent-runner.js';
export { stableId, modelBudgetExceeded } from './shared.js';
