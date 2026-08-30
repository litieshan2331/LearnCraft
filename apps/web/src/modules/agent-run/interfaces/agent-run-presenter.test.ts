/**
 * AgentRun 公开响应映射器单元测试。
 *
 * 测试：
 * - presentAgentRun：在前测或后测成功时传递安全的 assessment_id 引用。
 */

import { describe, expect, it } from "vitest";

import type { AgentRunSnapshot } from "../domain/agent-run";
import { presentAgentRun } from "./agent-run-presenter";

const agentRun: AgentRunSnapshot = {
  id: "e65747ed-612c-4828-a798-605ab7994034",
  runType: "assessment_generate",
  status: "succeeded",
  targetType: "learning_goal",
  targetId: "a59c8d15-2d5f-4668-85cc-9359093c046e",
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "87257ddb-2ba9-45f4-9136-3b713f633637",
  startedAt: new Date("2026-08-11T15:21:47.105Z"),
  finishedAt: new Date("2026-08-11T15:22:47.105Z"),
  assessmentResult: {
    assessmentId: "f18621a7-4309-4a04-9769-4d602966a574",
    questionCount: 10,
  },
  createdAt: new Date("2026-08-11T15:21:38.586Z"),
  updatedAt: new Date("2026-08-11T15:22:47.105Z"),
};

describe("presentAgentRun", () => {
  it("返回可用于读取题集的安全结果引用", () => {
    expect(presentAgentRun(agentRun)).toMatchObject({
      status: "succeeded",
      assessment_result: {
        assessment_id: "f18621a7-4309-4a04-9769-4d602966a574",
        question_count: 10,
      },
    });
  });

  it("后测成功时同样返回可读取题集的安全结果引用", () => {
    const posttestRun: AgentRunSnapshot = {
      ...agentRun,
      runType: "posttest_generate",
      targetType: "plan_node",
    };

    expect(presentAgentRun(posttestRun)).toMatchObject({
      run_type: "posttest_generate",
      assessment_result: {
        assessment_id: "f18621a7-4309-4a04-9769-4d602966a574",
        question_count: 10,
      },
    });
  });
});
