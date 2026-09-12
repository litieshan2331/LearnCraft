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
  createPosttestRun,
  getAssessmentAttempt,
  getAssessmentAttempts,
  getPosttestAssessmentAttempts,
  getAgentRun,
  getAssessment,
  submitAssessmentAttempt,
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


  it("创建节点后测任务时携带节点路径、题量、难度和幂等键", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "run-2", status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await createPosttestRun(
      "node-1",
      { question_count: 6, difficulty: "normal" },
      "16b28ac1-266a-43ed-b6fc-8c54ce6ae96c",
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/plan-nodes/node-1/post-assessment-runs");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("16b28ac1-266a-43ed-b6fc-8c54ce6ae96c");
    expect(JSON.parse(init.body as string)).toEqual({ question_count: 6, difficulty: "normal" });
  });  it("读取任务与题集时调用对应的受保护接口", async () => {
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

  it("读取节点下全部后测作答记录", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getPosttestAssessmentAttempts("node-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/plan-nodes/node-1/post-assessment-attempts");
  });

  it("提交作答时携带幂等键，并读取作答历史和详情", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "attempt-1", items: [] }, 201))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "attempt-1", items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await submitAssessmentAttempt(
      "assessment-1",
      { answers: [{ assessment_item_id: "item-1", selected_option_key: "A" }] },
      "16b28ac1-266a-43ed-b6fc-8c54ce6ae96c",
    );
    await getAssessmentAttempts("assessment-1");
    await getAssessmentAttempt("attempt-1");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/assessments/assessment-1/attempts");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("16b28ac1-266a-43ed-b6fc-8c54ce6ae96c");
    expect(fetchMock.mock.calls.slice(1).map(([calledPath]) => calledPath)).toEqual([
      "/api/v1/assessments/assessment-1/attempts",
      "/api/v1/assessment-attempts/attempt-1",
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
