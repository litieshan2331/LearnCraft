/**
 * 思考原文上报器的单元测试。
 *
 * 重点固化（2026-09-18 用户确认的实时透传语义）：
 * - 每段增量立即透传，不缓冲、不合并、无字符/时间阈值；
 * - 空增量被忽略；
 * - 轮次结束上报权威整段 thinking.completed，空白内容不上报。
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

describe('AgentThinkingStream', () => {
  it('每段增量立即透传，一条增量一条事件', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream(reporter);

    stream.push(1, '第一段');
    stream.push(1, '第二段');

    expect(reporter.events).toEqual([
      { step: 'thinking.delta', turn: 1, text: '第一段' },
      { step: 'thinking.delta', turn: 1, text: '第二段' },
    ]);
  });

  it('单字符增量同样立即透传（无最小长度阈值）', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream(reporter);

    stream.push(2, 'a');

    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]).toMatchObject({ step: 'thinking.delta', turn: 2, text: 'a' });
  });

  it('空增量被忽略', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream(reporter);

    stream.push(1, '');

    expect(reporter.events).toHaveLength(0);
  });

  it('轮次结束上报权威整段（去除首尾空白）', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream(reporter);

    stream.completeTurn(3, '  完整思考  ');

    expect(reporter.events).toEqual([
      { step: 'thinking.completed', turn: 3, text: '完整思考' },
    ]);
  });

  it('没有思考内容时不上报整段', () => {
    const reporter = new RecordingReporter();
    const stream = new AgentThinkingStream(reporter);

    stream.completeTurn(1, null);
    stream.completeTurn(1, undefined);
    stream.completeTurn(1, '   ');

    expect(reporter.events).toHaveLength(0);
  });
});
