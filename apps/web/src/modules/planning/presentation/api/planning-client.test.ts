/**
 * 学习路线 BFF 客户端回归测试。
 *
 * 测试：
 * - createPlanGenerationRun：发送正确的生成路径、空请求体与幂等键。
 * - getPlanGenerationRun、getLearningPlan、getPlanNode：读取受保护的路线资源。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlanGenerationRun,
  getLearningPlan,
  getPlanGenerationRun,
  getPlanNode,
} from "./planning-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planning-client", () => {
  it("创建路线生成任务时携带 UUID 幂等键和空对象请求体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "run-1", status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await createPlanGenerationRun(
      "a59c8d15-2d5f-4668-85cc-9359093c046e",
      "16b28ac1-266a-43ed-b6fc-8c54ce6ae96c",
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/learning-goals/a59c8d15-2d5f-4668-85cc-9359093c046e/plans");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("16b28ac1-266a-43ed-b6fc-8c54ce6ae96c");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("读取任务、路线和章节时调用对应的受保护接口", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1", status: "running" }))
      .mockResolvedValueOnce(jsonResponse({ id: "plan-1", nodes: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "node-1", title: "语法基础" }));
    vi.stubGlobal("fetch", fetchMock);

    await getPlanGenerationRun("run-1");
    await getLearningPlan("plan-1");
    await getPlanNode("node-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/agent-runs/run-1",
      "/api/v1/learning-plans/plan-1",
      "/api/v1/plan-nodes/node-1",
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
