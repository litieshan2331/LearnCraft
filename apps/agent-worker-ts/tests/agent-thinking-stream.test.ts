/**
 * 思考增量合并器的单元测试（注入时钟，结果完全确定）。
 *
 * 重点固化：字符阈值、时间阈值、轮次结束强制补发、单次运行总量上限与超限丢弃、
 * 以及空增量被忽略——这些行为与拆分前 tool-aware-generator.ts 内的内联实现逐条一致。
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentProgressData,
  AgentProgressReporter,
  AgentProgressStep,
} from '../src/application/services/agent-progress.js';
import { AgentThinkingStream } from '../src/application/services/agent-thinking-stream.js';

/** 记录型上报器：只关心 step、turn 与 text。 */
class RecordingReporter implements AgentProgressReporter {
  readonly events: Array<{ step: AgentProgressStep; turn: number; text: string }> = [];

  report(step: AgentProgressStep, data?: AgentProgressData): void {
    this.events.push({
      step,
      turn: Number(data?.turn ?? 0),
      text: typeof data?.text === 'string' ? data.text : '',
    });
  }
}

/** 可手动推进的时钟。 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('AgentThinkingStream', () => {
  it('达到字符阈值即上报', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream({
      report: reporter,
      flushChars: 40,
      flushIntervalMs: 1_000,
      now: () => 0,
    });

    stream.push(1, 'x'.repeat(40));

    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]).toMatchObject({ step: 'thinking.delta', turn: 1 });
    expect(reporter.events[0]?.text).toHaveLength(40);
  });

  it('未达阈值时不上报，轮次结束强制补发', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream({
      report: reporter,
      flushChars: 100,
      flushIntervalMs: 1_000,
      now: () => 0,
    });

    stream.push(1, '很短的一段');
    expect(reporter.events).toHaveLength(0);

    stream.flushTurn(1);
    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]?.text).toBe('很短的一段');
  });

  it('时间阈值到点后，下一段增量会连带缓冲一起上报', () => {
    const reporter = new RecordingReporter();
    const time = clock();
    const stream = new AgentThinkingStream({
      report: reporter,
      flushChars: 100,
      flushIntervalMs: 100,
      now: time.now,
    });

    stream.push(2, 'aaaaa');
    expect(reporter.events).toHaveLength(0);

    time.advance(150);
    stream.push(2, 'bbbbb');

    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]).toMatchObject({ turn: 2 });
    expect(reporter.events[0]?.text).toBe('aaaaabbbbb');
  });

  it('达到总量上限后按上限截断，并丢弃后续增量', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream({
      report: reporter,
      flushChars: 1,
      flushIntervalMs: 0,
      totalLimit: 10,
      now: () => 0,
    });

    stream.push(1, 'x'.repeat(12));
    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]?.text).toHaveLength(10);

    stream.push(1, 'yyyyy');
    stream.flushTurn(1);
    expect(reporter.events).toHaveLength(1);
  });

  it('空增量被忽略', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream({ report: reporter, now: () => 0 });

    stream.push(1, '');
    stream.flushTurn(1);

    expect(reporter.events).toHaveLength(0);
  });
});
