/**
 * 前测题集 BFF 客户端的回归测试。
 *
 * 测试：
 * - createAssessmentRun：发送正确路径、幂等键和请求体。
 * - getAgentRun、getAssessment：读取任务和题集时使用同源 Cookie 请求。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAssessmentRun,
  getAgentRun,
  getAssessment,
} from "./assessment-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assessment-client", () => {
  it("创建前测任务时携带 UUID 幂等键和配置", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "run-1", status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await createAssessmentRun(
      "a59c8d15-2d5f-4668-85cc-9359093c046e",
      { kind: "diagnostic", question_count: 10, difficulty: "normal" },
      "16b28ac1-266a-43ed-b6fc-8c54ce6ae96c",
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/learning-goals/a59c8d15-2d5f-4668-85cc-9359093c046e/assessment-runs");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("16b28ac1-266a-43ed-b6fc-8c54ce6ae96c");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "diagnostic",
      question_count: 10,
      difficulty: "normal",
    });
  });

  it("读取任务与题集时调用对应的受保护接口", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1", status: "running" }))
      .mockResolvedValueOnce(jsonResponse({ id: "assessment-1", items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getAgentRun("run-1");
    await getAssessment("assessment-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/agent-runs/run-1",
      "/api/v1/assessments/assessment-1",
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
