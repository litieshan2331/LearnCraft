/**
 * 进度面板的刷新恢复测试（服务端静态渲染，不建立 SSE）。
 *
 * 重点固化：挂载时从本标签页 sessionStorage 快照恢复步骤与思考，并照常渲染；
 * 没有快照时仍然返回空（由父组件等待界面承担）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunProgress } from "../../src/modules/agent-run/presentation/components/agent-run-progress";
import { writeAgentProgressSnapshot } from "../../src/modules/agent-run/presentation/agent-progress-storage";

const RUN_ID = "b7be50d5-3c47-4b05-b65c-1a77f2034f21";

/** 最小可用的 Storage 假实现；以全局 window.sessionStorage 注入给组件。 */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentRunProgress 刷新恢复", () => {
  it("挂载时恢复暂存的步骤与思考并渲染", () => {
    const storage = new FakeStorage();
    writeAgentProgressSnapshot(RUN_ID, {
      events: [{
        v: 1,
        step: "turn.started",
        at: "2026-09-23T07:00:00.000Z",
        seq: 7,
        data: { turn: 1 },
      }],
      thinkingTurns: [{ turn: 1, text: "刷新前已经收到的思考" }],
    }, storage);
    vi.stubGlobal("window", { sessionStorage: storage });

    const html = renderToStaticMarkup(<AgentRunProgress runId={RUN_ID} />);

    expect(html).toContain("刷新前已经收到的思考");
    expect(html).toContain("第 1 轮思考中…");
  });

  it("没有快照时不渲染（交给父组件的等待界面）", () => {
    vi.stubGlobal("window", { sessionStorage: new FakeStorage() });

    expect(renderToStaticMarkup(<AgentRunProgress runId={RUN_ID} />)).toBe("");
  });
});
