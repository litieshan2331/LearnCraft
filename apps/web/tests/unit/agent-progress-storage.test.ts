/**
 * AgentRun 进度浏览器暂存的单元测试。
 *
 * 重点固化：写入后能读回、runId 不匹配/过期/非法 JSON 一律返回 null 并清理条目、
 * 超限裁剪（事件 30 条 / 思考 3 轮 / 每轮 4000 字符）、存储读写抛错时静默忽略、clear 删除条目。
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_PROGRESS_STORAGE_PREFIX,
  AGENT_PROGRESS_STORAGE_TTL_MS,
  clearAgentProgressSnapshot,
  readAgentProgressSnapshot,
  writeAgentProgressSnapshot,
} from "../../src/modules/agent-run/presentation/agent-progress-storage";

const RUN_ID = "b7be50d5-3c47-4b05-b65c-1a77f2034f21";

/** 最小可用的 Storage 假实现（不依赖 jsdom）。 */
class FakeStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

function progressEvent(seq: number) {
  return {
    v: 1 as const,
    step: "turn.started",
    at: "2026-09-23T07:00:00.000Z",
    seq,
    data: { turn: 1 },
  };
}

describe("agent-progress-storage", () => {
  it("写入后能读回同一份事件与思考", () => {
    const storage = new FakeStorage();
    writeAgentProgressSnapshot(
      RUN_ID,
      { events: [progressEvent(1)], thinkingTurns: [{ turn: 1, text: "第一轮思考" }] },
      storage,
    );

    expect(readAgentProgressSnapshot(RUN_ID, storage)).toEqual({
      events: [progressEvent(1)],
      thinkingTurns: [{ turn: 1, text: "第一轮思考" }],
    });
  });

  it("runId 不匹配时返回 null 并清理该条目", () => {
    const storage = new FakeStorage();
    writeAgentProgressSnapshot(RUN_ID, { events: [progressEvent(1)], thinkingTurns: [] }, storage);
    const otherRunId = "11111111-2222-4333-8444-555555555555";

    expect(readAgentProgressSnapshot(otherRunId, storage)).toBeNull();

    // 把 A 的快照塞进 B 的键：读取 B 时判为不匹配并删除
    storage.setItem(
      AGENT_PROGRESS_STORAGE_PREFIX + otherRunId,
      storage.getItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID) as string,
    );
    expect(readAgentProgressSnapshot(otherRunId, storage)).toBeNull();
    expect(storage.getItem(AGENT_PROGRESS_STORAGE_PREFIX + otherRunId)).toBeNull();
  });

  it("过期快照返回 null 并删除", () => {
    const storage = new FakeStorage();
    storage.setItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID, JSON.stringify({
      runId: RUN_ID,
      savedAt: Date.now() - AGENT_PROGRESS_STORAGE_TTL_MS - 1,
      events: [progressEvent(1)],
      thinkingTurns: [],
    }));

    expect(readAgentProgressSnapshot(RUN_ID, storage)).toBeNull();
    expect(storage.getItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID)).toBeNull();
  });

  it("非法 JSON 返回 null 并删除，结构非法则只丢弃非法项", () => {
    const storage = new FakeStorage();
    storage.setItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID, "{不是 JSON");
    expect(readAgentProgressSnapshot(RUN_ID, storage)).toBeNull();
    expect(storage.getItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID)).toBeNull();

    storage.setItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID, JSON.stringify({
      runId: RUN_ID,
      savedAt: Date.now(),
      events: [progressEvent(2), "bad"],
      thinkingTurns: [{ turn: "a", text: 1 }],
    }));
    expect(readAgentProgressSnapshot(RUN_ID, storage)).toEqual({
      events: [progressEvent(2)],
      thinkingTurns: [],
    });
  });

  it("按上限裁剪：事件 30 条、思考 3 轮、每轮 4000 字符", () => {
    const storage = new FakeStorage();
    const events = Array.from({ length: 40 }, (_item, index) => progressEvent(index + 1));
    const thinkingTurns = Array.from({ length: 5 }, (_item, index) => ({
      turn: index + 1,
      text: "x".repeat(4_500),
    }));

    writeAgentProgressSnapshot(RUN_ID, { events, thinkingTurns }, storage);

    const stored = readAgentProgressSnapshot(RUN_ID, storage);
    expect(stored?.events).toHaveLength(30);
    expect(stored?.events[0]?.seq).toBe(11);
    expect(stored?.thinkingTurns.map((turn) => turn.turn)).toEqual([3, 4, 5]);
    expect(stored?.thinkingTurns[0]?.text).toHaveLength(4_000);
  });

  it("存储读写抛错时静默忽略", () => {
    const broken = {
      length: 0,
      clear: () => undefined,
      getItem: (): string | null => { throw new Error("denied"); },
      key: () => null,
      removeItem: (): void => { throw new Error("denied"); },
      setItem: (): void => { throw new Error("quota"); },
    } as unknown as Storage;

    expect(readAgentProgressSnapshot(RUN_ID, broken)).toBeNull();
    expect(() => writeAgentProgressSnapshot(
      RUN_ID,
      { events: [progressEvent(1)], thinkingTurns: [] },
      broken,
    )).not.toThrow();
    expect(() => clearAgentProgressSnapshot(RUN_ID, broken)).not.toThrow();
  });

  it("clear 删除快照；无内容时不写入", () => {
    const storage = new FakeStorage();
    writeAgentProgressSnapshot(RUN_ID, { events: [progressEvent(1)], thinkingTurns: [] }, storage);
    clearAgentProgressSnapshot(RUN_ID, storage);
    expect(readAgentProgressSnapshot(RUN_ID, storage)).toBeNull();

    writeAgentProgressSnapshot(RUN_ID, { events: [], thinkingTurns: [] }, storage);
    expect(storage.getItem(AGENT_PROGRESS_STORAGE_PREFIX + RUN_ID)).toBeNull();
  });
});
