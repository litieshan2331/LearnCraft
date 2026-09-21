/**
 * 模型思考增量的合并与上报（自 tool-aware-generator.ts 拆出，逻辑不变）。
 *
 * 职责：把流式到达的思考增量先缓冲，再按「字符数阈值」或「时间阈值」合并成一条
 * `thinking.delta` 进度事件；轮次结束时强制补发剩余内容，并限制单次运行的上报总量。
 * 与 ReAct 循环解耦：循环只负责「增量到达时 push」与「轮次结束时 flushTurn」，
 * 本模块只负责节流、补发与上限；不落库、不写日志，上报只经 AgentProgressReporter。
 *
 * 不使用定时器：只在增量到达或轮次结束时判断是否该发，因此不会为一个已结束的轮次补发。
 *
 * 导出：
 * - DEFAULT_THINKING_FLUSH_CHARS / DEFAULT_THINKING_FLUSH_MS / DEFAULT_THINKING_TOTAL_LIMIT：默认阈值。
 * - AgentThinkingStreamOptions：上报端口、阈值与可注入时钟。
 * - AgentThinkingStream：push（追加增量）/ flushTurn（轮次结束强制补发）。
 * - createAgentThinkingStream：按默认阈值创建实例。
 */

import type { AgentProgressReporter } from './agent-progress.js';

/** 默认字符数阈值：缓冲达到该长度即上报（越小越流畅，频道消息越多）。 */
export const DEFAULT_THINKING_FLUSH_CHARS = 40;
/** 默认时间阈值：距上次上报超过该毫秒数且有新内容时上报。 */
export const DEFAULT_THINKING_FLUSH_MS = 80;
/** 默认单次运行上报总量上限：达到后丢弃后续增量，避免长时间会话占满临时通道。 */
export const DEFAULT_THINKING_TOTAL_LIMIT = 64_000;

export interface AgentThinkingStreamOptions {
  /** 进度上报端口（通常是 Redis 发布器创建的上报器）。 */
  report: AgentProgressReporter;
  /** 字符数阈值，默认 DEFAULT_THINKING_FLUSH_CHARS。 */
  flushChars?: number;
  /** 时间阈值（毫秒），默认 DEFAULT_THINKING_FLUSH_MS。 */
  flushIntervalMs?: number;
  /** 单次运行总量上限（字符），默认 DEFAULT_THINKING_TOTAL_LIMIT。 */
  totalLimit?: number;
  /** 时钟注入，便于单测；默认 Date.now。 */
  now?: () => number;
}

export class AgentThinkingStream {
  private readonly report: AgentProgressReporter;
  private readonly flushChars: number;
  private readonly flushIntervalMs: number;
  private readonly totalLimit: number;
  private readonly now: () => number;

  /** 尚未上报的增量。 */
  private buffer = '';
  /** 上次上报时间；初始为 0，使首个增量立即可见。 */
  private lastFlushAt = 0;
  /** 已上报的思考原文总长度。 */
  private published = 0;

  constructor(options: AgentThinkingStreamOptions) {
    this.report = options.report;
    this.flushChars = options.flushChars ?? DEFAULT_THINKING_FLUSH_CHARS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_THINKING_FLUSH_MS;
    this.totalLimit = options.totalLimit ?? DEFAULT_THINKING_TOTAL_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  /** 追加一段思考增量；达到任一阈值时合并上报（不足则留在缓冲里等下次）。 */
  push(turn: number, delta: string): void {
    if (delta.length === 0) {
      return;
    }
    this.buffer += delta;
    this.drain(turn, false);
  }

  /** 轮次结束：强制补发缓冲中的剩余增量（即使未达阈值）。 */
  flushTurn(turn: number): void {
    this.drain(turn, true);
  }

  /** 按阈值判断是否上报；force 时忽略阈值。达到总量上限后丢弃缓冲。 */
  private drain(turn: number, force: boolean): void {
    if (this.buffer.length === 0) {
      return;
    }
    const now = this.now();
    if (
      !force
      && this.buffer.length < this.flushChars
      && now - this.lastFlushAt < this.flushIntervalMs
    ) {
      return;
    }
    if (this.published >= this.totalLimit) {
      this.buffer = '';
      return;
    }
    const chunk = this.buffer.slice(0, this.totalLimit - this.published);
    this.buffer = this.buffer.slice(chunk.length);
    this.published += chunk.length;
    this.lastFlushAt = now;
    this.report.report('thinking.delta', { turn, text: chunk });
  }
}

/** 按默认阈值创建思考增量合并器。 */
export function createAgentThinkingStream(options: AgentThinkingStreamOptions): AgentThinkingStream {
  return new AgentThinkingStream(options);
}
