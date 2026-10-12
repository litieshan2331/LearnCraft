/**
 * 学习助手三个 Agent 的统一出口；角色实现和提示词各自独立。
 * 调用顺序：主图导入主 Agent 或指定子 Agent → 复用 shared 的模型调用、轨迹和子循环。
 */
export { runMainAgent } from './main-agent.js';
export { runErrorAttributionAgent } from './error-attribution-agent.js';
export { runSocraticTutorAgent } from './socratic-tutor-agent.js';
export { stableId, modelBudgetExceeded } from './shared.js';
