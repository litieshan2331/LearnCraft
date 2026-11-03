/**
 * 学习助手浏览器端 API 客户端测试。
 *
 * 调用顺序：替换同源 fetch → 调用会话、消息和发送客户端 → 校验请求路径、公开状态字段和幂等请求头。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLearningAssistantConversation,
  listLearningAssistantMessages,
  sendLearningAssistantMessage,
} from "../../src/modules/learning-assistant/presentation/api/learning-assistant-client";

describe("学习助手浏览器端 API 客户端", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("读取会话时保留教学状态字段", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "conversation-id",
      stage: "waiting_for_user",
      pending_question: "请指出边界条件。",
      hint_level: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLearningAssistantConversation("conversation-id")).resolves.toMatchObject({
      stage: "waiting_for_user",
      pending_question: "请指出边界条件。",
      hint_level: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/learning-assistant/conversations/conversation-id",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("按游标读取消息，并复用幂等键发送消息", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], next_after_sequence_no: 42 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: {}, run: {}, created: true }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: {}, run: {}, created: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLearningAssistantMessages("conversation-id", 41)).resolves.toEqual({ items: [], next_after_sequence_no: 42 });
    await sendLearningAssistantMessage("conversation-id", "分析循环", "idempotency-key");
    await sendLearningAssistantMessage("conversation-id", "分析循环", "idempotency-key");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/learning-assistant/conversations/conversation-id/messages?after_sequence_no=41&limit=100");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idempotency-key" },
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "Idempotency-Key": "idempotency-key" }),
    });
  });

  it("保留忙碌错误码供界面显示安全提示", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "CONVERSATION_BUSY", message: "内部异常内容" },
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(sendLearningAssistantMessage("conversation-id", "继续", "same-key"))
      .rejects.toMatchObject({
        code: "CONVERSATION_BUSY",
        message: "当前会话已有消息正在处理，请稍后再试。",
      });
  });
});
