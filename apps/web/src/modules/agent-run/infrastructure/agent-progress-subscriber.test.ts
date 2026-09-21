/**
 * 进度订阅适配器的测试（不连真实 Redis）。
 *
 * 重点固化：频道命名与 Worker 一致、消息白名单校验（非法内容一律丢弃）、
 * 思考原文（thinking.completed）的放行与长度上限，以及未配置连接串时的降级异常。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PROGRESS_CHANNEL_PREFIX,
  AgentProgressUnavailableError,
  agentProgressChannel,
  parseAgentProgressEvent,
  subscribeAgentProgress,
} from "./agent-progress-subscriber";

const VALID_EVENT = {
  v: 1,
  step: "tool.called",
  at: "2026-09-18T02:00:00.000Z",
  seq: 2,
  data: { turn: 1, call_index: 1, tool: "tavily_search", query: "TypeScript 类型" },
};

describe("频道命名", () => {
  it("与 Worker 的发布前缀一致，且只订阅 runId 派生频道", () => {
    expect(AGENT_PROGRESS_CHANNEL_PREFIX).toBe("learncraft:agent-progress:");
    expect(agentProgressChannel("11111111-2222-4333-8444-555555555555"))
      .toBe("learncraft:agent-progress:11111111-2222-4333-8444-555555555555");
  });
});

describe("parseAgentProgressEvent", () => {
  it("接受合法事件", () => {
    expect(parseAgentProgressEvent(JSON.stringify(VALID_EVENT))).toMatchObject({
      step: "tool.called",
      seq: 2,
    });
  });

  it("接受带思考原文的事件，且上限为 4000 字符", () => {
    const accepted = {
      ...VALID_EVENT,
      step: "thinking.completed",
      data: { turn: 1, text: "思考".repeat(1_000) },
    };
    expect(parseAgentProgressEvent(JSON.stringify(accepted))?.step).toBe("thinking.completed");
    expect(
      parseAgentProgressEvent(JSON.stringify({ ...accepted, step: "thinking.delta" }))?.step,
    ).toBe("thinking.delta");

    const tooLong = {
      ...VALID_EVENT,
      step: "thinking.completed",
      data: { turn: 1, text: "x".repeat(4_001) },
    };
    expect(parseAgentProgressEvent(JSON.stringify(tooLong))).toBeNull();
  });

  it("丢弃非 JSON、非对象与协议版本不符的消息", () => {
    expect(parseAgentProgressEvent("不是 JSON")).toBeNull();
    expect(parseAgentProgressEvent("[]")).toBeNull();
    expect(parseAgentProgressEvent(JSON.stringify({ ...VALID_EVENT, v: 2 }))).toBeNull();
  });

  it("丢弃未在白名单中的 step 与超长参数", () => {
    expect(parseAgentProgressEvent(JSON.stringify({ ...VALID_EVENT, step: "model.content" }))).toBeNull();
    expect(
      parseAgentProgressEvent(
        JSON.stringify({ ...VALID_EVENT, data: { query: "x".repeat(4_001) } }),
      ),
    ).toBeNull();
  });
});

describe("subscribeAgentProgress", () => {
  const previous = process.env.AGENT_PROGRESS_REDIS_URL;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.AGENT_PROGRESS_REDIS_URL;
    } else {
      process.env.AGENT_PROGRESS_REDIS_URL = previous;
    }
  });

  it("未配置连接串时抛 AgentProgressUnavailableError（供上层降级）", async () => {
    process.env.AGENT_PROGRESS_REDIS_URL = "";

    await expect(
      subscribeAgentProgress({ runId: "11111111-2222-4333-8444-555555555555", onEvent: () => undefined }),
    ).rejects.toBeInstanceOf(AgentProgressUnavailableError);
  });
});
