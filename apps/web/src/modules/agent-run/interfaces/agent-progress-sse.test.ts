/**
 * 进度 SSE 适配器的测试（不连真实 Redis）。
 *
 * 重点固化：响应头符合 SSE 约定、订阅不可用时仍返回正常流（优雅降级）、
 * 事件按 `data: <json>\n\n` 成帧，以及客户端取消时释放订阅。
 */
import { describe, expect, it } from "vitest";

import type { AgentProgressEvent } from "../infrastructure/agent-progress-subscriber";
import { createAgentProgressSseResponse } from "./agent-progress-sse";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

describe("createAgentProgressSseResponse", () => {
  it("订阅不可用时仍返回 200 与 text/event-stream（前端回退到状态轮询）", async () => {
    const controller = new AbortController();
    const response = createAgentProgressSseResponse({
      runId: RUN_ID,
      subscribe: async () => {
        throw new Error("redis 不可用");
      },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
    controller.abort();
  });

  it("把事件写为 SSE 帧，并在取消时关闭订阅", async () => {
    const controller = new AbortController();
    // 初值为空操作：避免可空类型在 await 之后被 TypeScript 收窄。
    let emit: (event: AgentProgressEvent) => void = () => undefined;
    let closed = false;
    const response = createAgentProgressSseResponse({
      runId: RUN_ID,
      subscribe: async (input) => {
        emit = input.onEvent;
        return {
          close: async () => {
            closed = true;
          },
        };
      },
      signal: controller.signal,
    });

    // 等待 ReadableStream.start 内的订阅建立完成。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const event: AgentProgressEvent = {
      v: 1,
      step: "turn.started",
      at: "2026-09-18T02:00:00.000Z",
      seq: 1,
      data: { turn: 1 },
    };
    emit(event);
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toBe("data: " + JSON.stringify(event) + "\n\n");

    await reader?.cancel();
    expect(closed).toBe(true);
    controller.abort();
  });
});
