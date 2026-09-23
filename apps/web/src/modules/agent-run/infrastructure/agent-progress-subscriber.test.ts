/**
 * 进度订阅适配器的测试（不连真实 Redis）。
 *
 * 重点固化：频道命名与 Worker 一致、消息白名单校验（非法内容一律丢弃）、
 * 思考原文（thinking.completed）的放行与长度上限、序号不设上限（长运行不整段失效）、
 * 思考增量超限后只丢增量而保留步骤事件，以及未配置连接串时的降级异常。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PROGRESS_CHANNEL_PREFIX,
  AGENT_PROGRESS_MAX_THINKING_DELTAS,
  AgentProgressUnavailableError,
  agentProgressChannel,
  createAgentProgressForwarder,
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

  it("序号只要求非负整数，不再有 1 万上限", () => {
    expect(parseAgentProgressEvent(JSON.stringify({ ...VALID_EVENT, seq: 123_456 }))?.seq).toBe(123_456);
    expect(parseAgentProgressEvent(JSON.stringify({ ...VALID_EVENT, seq: -1 }))).toBeNull();
    expect(parseAgentProgressEvent(JSON.stringify({ ...VALID_EVENT, seq: 1.5 }))).toBeNull();
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

describe("createAgentProgressForwarder", () => {
  it("转发合法事件，静默丢弃非法消息", () => {
    const received: string[] = [];
    const forward = createAgentProgressForwarder((event) => received.push(event.step));

    forward(JSON.stringify(VALID_EVENT));
    forward("不是 JSON");
    forward(JSON.stringify({ ...VALID_EVENT, step: "model.content" }));

    expect(received).toEqual(["tool.called"]);
  });

  it("思考增量超过上限后只丢增量，步骤事件与轮末整段照常转发", () => {
    const received: string[] = [];
    const forward = createAgentProgressForwarder((event) => received.push(event.step));
    const delta = JSON.stringify({
      ...VALID_EVENT,
      step: "thinking.delta",
      data: { turn: 1, text: "思考片段" },
    });

    for (let index = 0; index < AGENT_PROGRESS_MAX_THINKING_DELTAS; index += 1) {
      forward(delta);
    }
    forward(delta);
    forward(JSON.stringify({
      ...VALID_EVENT,
      step: "thinking.completed",
      data: { turn: 1, text: "该轮完整思考" },
    }));
    forward(JSON.stringify({ ...VALID_EVENT, step: "run.completed" }));

    expect(received.filter((step) => step === "thinking.delta"))
      .toHaveLength(AGENT_PROGRESS_MAX_THINKING_DELTAS);
    expect(received).toContain("thinking.completed");
    expect(received.at(-1)).toBe("run.completed");
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
