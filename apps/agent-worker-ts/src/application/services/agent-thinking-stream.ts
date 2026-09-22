/**
 * 模型思考原文的上报（自 tool-aware-generator.ts 拆出；**不含任何缓冲、节流或总量限制**）。
 *
 * 职责：把模型思考原文以最实时的方式交给进度通道：
 * - push：流式增量到达即透传一条 `thinking.delta`（不缓冲、不合并、不限速）；
 * - completeTurn：轮次结束时上报该轮权威整段 `thinking.completed`，前端用它覆盖本轮增量。
 *
 * 设计取舍（2026-09-18 用户确认）：**只有工具调用需要缓冲完整结构化结果**；
 * 思考流要实时送达前端，因此这里不做字符阈值、时间窗或总量截断，也不使用定时器。
 * 既有的相关边界不在本模块：出网层单次响应 8MB 上限（模型侧）、浏览器只保留最近若干字符（展示侧）。
 *
 * 不落库、不写日志：上报只经 AgentProgressReporter（见 agent-progress.ts）。
 *
 * 导出：
 * - AgentThinkingStream：push（增量透传）/ completeTurn（轮次权威整段）。
 * - createAgentThinkingStream：创建实例。
 */

import type { AgentProgressReporter } from './agent-progress.js';

export class AgentThinkingStream {
  constructor(private readonly report: AgentProgressReporter) {}

  /** 追加一段思考增量：立即透传，不缓冲也不合并；空增量直接忽略。 */
  push(turn: number, delta: string): void {
    if (delta.length === 0) {
      return;
    }
    this.report.report('thinking.delta', { turn, text: delta });
  }

  /**
   * 轮次结束：上报该轮完整思考原文（权威整段），供前端覆盖本轮增量。
   * 空白内容视为该轮没有可展示的思考，不上报。
   */
  completeTurn(turn: number, reasoning: string | null | undefined): void {
    if (typeof reasoning !== 'string') {
      return;
    }
    const text = reasoning.trim();
    if (text.length === 0) {
      return;
    }
    this.report.report('thinking.completed', { turn, text });
  }
}

/** 创建思考原文上报器（实时透传，无阈值参数）。 */
export function createAgentThinkingStream(report: AgentProgressReporter): AgentThinkingStream {
  return new AgentThinkingStream(report);
}
