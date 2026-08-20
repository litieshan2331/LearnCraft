/**
 * 学习画像与学习目标 BFF 客户端的回归测试。
 *
 * 测试：
 * - getLearningGoals：读取目标列表及其最新前测摘要。
 * - deleteLearningGoal：处理无响应体的 204 删除成功响应。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteLearningGoal, getLearningGoals } from "./profile-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profile-client", () => {
  it("读取学习目标列表时使用同源受保护接口", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [{
        id: "goal-1",
        topic: "TypeScript",
        title: "掌握类型系统",
        description: "学习泛型和类型收窄。",
        desired_outcome: "可以维护项目类型定义。",
        target_date: null,
        weekly_minutes_override: null,
        model_connection_id: null,
        profile_version: 1,
        status: "assessment_pending",
        created_at: "2026-08-18T00:00:00.000Z",
        updated_at: "2026-08-18T00:00:00.000Z",
        latest_assessment: null,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const goals = await getLearningGoals();

    expect(goals).toHaveLength(1);
    expect(goals[0]?.title).toBe("掌握类型系统");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/learning-goals");
    expect(init.credentials).toBe("same-origin");
  });

  it("删除学习目标时接受 204 无响应体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteLearningGoal("goal-1")).resolves.toBeUndefined();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/learning-goals/goal-1");
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("same-origin");
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
