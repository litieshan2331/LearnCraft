/**
 * PostgreSQL 轨迹 SSE 重放与实时追加测试。
 *
 * 调用顺序：构造内存事件页，创建流，读取补发及追加帧，再校验终态关闭和断线释放。
 */

import { describe, expect, it } from "vitest";

import { createAgentTraceSseResponse } from "./agent-trace-sse";

const NOW = new Date("2026-09-29T00:00:00.000Z");

/** 生成最小的完整轨迹事件供 SSE 测试。 */
function traceEvent(sequenceNo: number, eventType = "tool.completed") {
  return {
    sequenceNo, eventType, turnNo: 1, stepNo: 1, attemptNo: null,
    startedAt: NOW, finishedAt: NOW, inputTokens: null, outputTokens: null,
    payloadJson: { value: sequenceNo }, createdAt: NOW,
  };
}

describe("Agent 轨迹 SSE", () => {
  it("从 after 补发、按 id 追加，并在终态读尽后关闭", async () => {
    const reads: number[] = [];
    let status = "running";
    const response = createAgentTraceSseResponse({
      after: 1,
      signal: new AbortController().signal,
      pollMs: 1,
      readPage: async (after) => {
        reads.push(after);
        if (after === 1) {
          status = "succeeded";
          return { items: [traceEvent(2)], hasMore: false };
        }
        status = "succeeded";
        return { items: [traceEvent(3, "run.completed")], hasMore: false };
      },
      readStatus: async () => status,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const content = await response.text();
    expect(reads).toEqual([1, 2]);
    expect(content).toContain("id: 2\nevent: trace\n");
    expect(content).toContain("id: 3\nevent: trace\n");
    expect(content).not.toContain("id: 1\n");
  });

  it("客户端取消后不再轮询", async () => {
    const abort = new AbortController();
    let reads = 0;
    const response = createAgentTraceSseResponse({
      after: 0,
      signal: abort.signal,
      pollMs: 1_000,
      readPage: async () => { reads += 1; return { items: [], hasMore: false }; },
      readStatus: async () => "running",
    });
    await response.body?.cancel();
    abort.abort();
    expect(reads).toBe(1);
  });
});
