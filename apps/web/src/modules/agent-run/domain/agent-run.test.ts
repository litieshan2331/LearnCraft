/**
 * AgentRun 领域状态机规则的单元测试。
 *
 * 测试：
 * - getAgentRunCancellationDecision：验证排队、运行、已取消和已结束任务的协作式取消边界。
 * - isAgentRunType、isAgentRunStatus：验证数据库状态映射前的白名单校验。
 */

import { describe, expect, it } from "vitest";

import {
  getAgentRunCancellationDecision,
  isAgentRunStatus,
  isAgentRunType,
} from "./agent-run";

describe("AgentRun 协作式取消状态机", () => {
  it.each(["queued", "running"] as const)("允许取消 %s 任务", (status) => {
    expect(getAgentRunCancellationDecision(status)).toBe("cancel");
  });

  it("将已取消任务视为幂等成功", () => {
    expect(getAgentRunCancellationDecision("cancelled")).toBe("already_cancelled");
  });

  it.each(["succeeded", "failed", "expired"] as const)("拒绝取消已结束的 %s 任务", (status) => {
    expect(getAgentRunCancellationDecision(status)).toBe("not_cancellable");
  });
});

describe("AgentRun 枚举白名单", () => {
  it("接受已定义的任务类型和状态", () => {
    expect(isAgentRunType("plan_generate")).toBe(true);
    expect(isAgentRunStatus("running")).toBe(true);
  });

  it("拒绝未知的任务类型和状态", () => {
    expect(isAgentRunType("unknown")).toBe(false);
    expect(isAgentRunStatus("paused")).toBe(false);
  });
});
