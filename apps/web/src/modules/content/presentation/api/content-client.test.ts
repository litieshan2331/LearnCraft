/**
 * 节点知识内容 BFF 客户端回归测试。
 *
 * 测试：
 * - createCardContentGenerationRun：发送内容生成路径、幂等键和空对象请求体。
 * - getCardContentGenerationRun、getCardContent：读取任务状态和已成功内容。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCardContentGenerationRun,
  getCardContentGenerationRun,
  getCardContent,
} from "./content-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-client", () => {
  it("创建节点内容任务时携带 UUID 幂等键和空对象请求体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "run-1", status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await createCardContentGenerationRun(
      "a59c8d15-2d5f-4668-85cc-9359093c046e",
      "16b28ac1-266a-43ed-b6fc-8c54ce6ae96c",
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/plan-nodes/a59c8d15-2d5f-4668-85cc-9359093c046e/content-runs");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("16b28ac1-266a-43ed-b6fc-8c54ce6ae96c");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("读取节点内容任务和已成功内容时调用对应受保护接口", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1", status: "running" }))
      .mockResolvedValueOnce(jsonResponse({ id: "content-1", status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);

    await getCardContentGenerationRun("run-1");
    await getCardContent("content-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/agent-runs/run-1",
      "/api/v1/card-contents/content-1",
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
