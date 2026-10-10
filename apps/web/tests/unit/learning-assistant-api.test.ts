/**
 * 学习助手 HTTP API 的认证、输入与公开响应行为测试。
 *
 * 调用顺序：模拟认证服务和应用服务 → 调用真实 Route、Zod 与 presenter →
 * 验证身份来自 Session、写入来源、重试状态码、历史游标和内部数据不外泄。
 * 默认 Vitest 没有路径别名，下面的模块桥接只供本测试解析真实适配器。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listConversations, POST as createConversation } from "../../src/app/api/v1/learning-assistant/conversations/route";
import { GET as getConversation } from "../../src/app/api/v1/learning-assistant/conversations/[conversationId]/route";
import { GET as listMessages, POST as sendMessage } from "../../src/app/api/v1/learning-assistant/conversations/[conversationId]/messages/route";
import { GET as getRun } from "../../src/app/api/v1/learning-assistant/runs/[runId]/route";
import { LearningAssistantApplicationError } from "../../src/modules/learning-assistant/application/learning-assistant-service";
import type { ConversationSnapshot, MessageSnapshot, RunSnapshot } from "../../src/modules/learning-assistant/domain/learning-assistant";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  service: {
    listConversations: vi.fn(), createConversation: vi.fn(), getConversation: vi.fn(),
    listMessages: vi.fn(), sendMessage: vi.fn(), getRun: vi.fn(),
  },
}));

// 工厂替身隔离数据库和 Redis，其余 HTTP 适配器使用真实实现。
vi.mock("@/modules/learning-assistant/infrastructure/learning-assistant-service-factory", () => ({
  getLearningAssistantService: () => mocks.service,
}));
vi.mock("@/modules/identity/infrastructure/authentication-service-factory", () => ({
  getAuthenticationService: () => ({ getCurrentUser: mocks.getCurrentUser }),
}));
vi.mock("@/modules/learning-assistant/interfaces/learning-assistant-schemas", async () => import("../../src/modules/learning-assistant/interfaces/learning-assistant-schemas"));
vi.mock("@/modules/learning-assistant/interfaces/learning-assistant-presenter", async () => import("../../src/modules/learning-assistant/interfaces/learning-assistant-presenter"));
vi.mock("@/modules/learning-assistant/interfaces/learning-assistant-http", async () => import("../../src/modules/learning-assistant/interfaces/learning-assistant-http"));
vi.mock("@/modules/identity/interfaces/auth-http", async () => import("../../src/modules/identity/interfaces/auth-http"));
vi.mock("@/modules/identity/domain/authentication", async () => import("../../src/modules/identity/domain/authentication"));
vi.mock("@/lib/session/session-cookie", async () => import("../../src/lib/session/session-cookie"));

const ownerId = "11111111-2222-4333-8444-555555555555";
const conversationId = "66666666-7777-4888-9999-000000000000";
const runId = "88888888-1111-4222-8333-444444444444";
const idempotencyKey = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const now = new Date("2026-10-10T00:00:00.000Z");
const conversation: ConversationSnapshot = {
  id: conversationId, ownerId, goalId: null, sourceAssessmentAnswerId: null,
  status: "active", stage: "new", stateJson: { private_memory: "内部事实" },
  lastMessageAt: null, createdAt: now, updatedAt: now,
};
const message: MessageSnapshot = {
  id: "99999999-1111-4222-8333-444444444444", conversationId, sequenceNo: 1, turnNo: 1,
  role: "user", content: "请帮我分析代码", toolName: null, toolCallId: null,
  toolInputJson: {}, toolResultJson: {}, metadataJson: { internal_prompt: "内部提示词" }, createdAt: now,
};
const run: RunSnapshot = {
  id: runId, ownerId, conversationId, triggerMessageId: message.id, idempotencyKey,
  status: "queued", orchestrationVersion: "learning-assistant-mvp-v1", modelId: null,
  inputTokens: 0, outputTokens: 0, modelCallCount: 0, toolCallCount: 0,
  subAgentSummaryJson: [{ private: "内部 Agent" }], skillSummaryJson: [], tavilySummaryJson: [],
  inputSummaryJson: { private_memory: "记忆" }, outputSummaryJson: {},
  errorCode: null, errorSummary: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
};
const conversationContext = { params: Promise.resolve({ conversationId }) };
const runContext = { params: Promise.resolve({ runId }) };

/** 构造带 Session、来源和幂等键的浏览器请求。 */
function request(path: string, body?: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/v1/learning-assistant${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: "lc_session=test-session", origin: "http://localhost",
      "content-type": "application/json", "Idempotency-Key": idempotencyKey, ...headers,
    },
    body,
  });
}

describe("学习助手 HTTP API", () => {
  // 每个测试使用确定的 Session 和应用结果，不访问真实用户数据。
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "http://localhost");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    mocks.getCurrentUser.mockResolvedValue({ user: { id: ownerId }, renewedSessionExpiresAt: null });
    mocks.service.listConversations.mockResolvedValue([conversation]);
    mocks.service.createConversation.mockResolvedValue(conversation);
    mocks.service.getConversation.mockResolvedValue({ conversation, activeRun: run });
    mocks.service.listMessages.mockResolvedValue({ items: [message], nextAfterSequenceNo: null });
    mocks.service.sendMessage.mockResolvedValue({ message, run, created: true });
    mocks.service.getRun.mockResolvedValue(run);
  });

  // 恢复环境变量，避免影响其他测试文件的 Origin 或 Cookie 设置。
  afterEach(() => vi.unstubAllEnvs());

  it("全部接口使用 Session 身份，创建空目标会话并带出 active_run_id", async () => {
    const responses = [
      await listConversations(request("/conversations?limit=25")),
      await createConversation(request("/conversations", "{}")),
      await getConversation(request(`/conversations/${conversationId}`), conversationContext),
      await listMessages(request(`/conversations/${conversationId}/messages?after_sequence_no=25&limit=30`), conversationContext),
      await getRun(request(`/runs/${runId}`), runContext),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 201, 200, 200, 200]);
    expect(mocks.service.listConversations).toHaveBeenCalledWith(ownerId, 25);
    expect(mocks.service.createConversation).toHaveBeenCalledWith({ ownerId, goalId: null, sourceAssessmentAnswerId: null });
    expect(mocks.service.getConversation).toHaveBeenCalledWith(ownerId, conversationId);
    expect(mocks.service.listMessages).toHaveBeenCalledWith(ownerId, conversationId, { afterSequenceNo: 25, limit: 30 });
    expect(mocks.service.getRun).toHaveBeenCalledWith(ownerId, runId);
    expect(await responses[2].json()).toMatchObject({ id: conversationId, active_run_id: runId });
  });

  it("新消息返回 202，幂等重试返回 200，代码缩进不变", async () => {
    const content = "  function value() {\n    return 1;\n  }\n";
    const first = await sendMessage(request(`/conversations/${conversationId}/messages`, JSON.stringify({ content })), conversationContext);
    expect(first.status).toBe(202);
    expect(mocks.service.sendMessage).toHaveBeenCalledWith({ ownerId, conversationId, content, idempotencyKey: idempotencyKey.toLowerCase() });
    mocks.service.sendMessage.mockResolvedValue({ message, run, created: false });
    const repeated = await sendMessage(request(`/conversations/${conversationId}/messages`, JSON.stringify({ content })), conversationContext);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ message: { id: message.id }, run: { id: runId }, created: false });
  });

  it("未登录时所有入口返回 401、清除 Cookie，并且不调用应用服务", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const responses = await Promise.all([
      listConversations(request("/conversations")),
      createConversation(request("/conversations", "{}")),
      getConversation(request(`/conversations/${conversationId}`), conversationContext),
      listMessages(request(`/conversations/${conversationId}/messages`), conversationContext),
      sendMessage(request(`/conversations/${conversationId}/messages`, '{"content":"测试"}'), conversationContext),
      getRun(request(`/runs/${runId}`), runContext),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
    for (const response of responses) expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    for (const method of Object.values(mocks.service)) expect(method).not.toHaveBeenCalled();
  });

  it("外部来源不能创建会话或发送消息", async () => {
    const responses = await Promise.all([
      createConversation(request("/conversations", "{}", { origin: "https://untrusted.example" })),
      sendMessage(request(`/conversations/${conversationId}/messages`, '{"content":"测试"}', { origin: "" }), conversationContext),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(mocks.service.createConversation).not.toHaveBeenCalled();
    expect(mocks.service.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['{"content":"  "}', '{"content":"测试","owner_id":"伪造用户"}', '{"content":"测试","metadata_json":{"role":"tool"}}', '{'])
    ("非法消息 %s 不进入用例", async (body) => {
      const response = await sendMessage(request(`/conversations/${conversationId}/messages`, body), conversationContext);
      expect(response.status).toBe(422);
      expect(mocks.service.sendMessage).not.toHaveBeenCalled();
    });

  it("没有 UUID 幂等键时返回明确的 Header 校验错误", async () => {
    const response = await sendMessage(request(`/conversations/${conversationId}/messages`, '{"content":"测试"}', { "Idempotency-Key": "" }), conversationContext);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { field_errors: [{ field: "Idempotency-Key" }] } });
    expect(mocks.service.sendMessage).not.toHaveBeenCalled();
  });

  it("非法 UUID、负游标和过大的消息页不能进入应用服务", async () => {
    const invalidContext = { params: Promise.resolve({ conversationId: "invalid" }) };
    const responses = [
      await getConversation(request("/conversations/invalid"), invalidContext),
      await listMessages(request(`/conversations/${conversationId}/messages?after_sequence_no=-1`), conversationContext),
      await listMessages(request(`/conversations/${conversationId}/messages?limit=101`), conversationContext),
    ];
    expect(responses.map((response) => response.status)).toEqual([422, 422, 422]);
    expect(mocks.service.getConversation).not.toHaveBeenCalled();
    expect(mocks.service.listMessages).not.toHaveBeenCalled();
  });

  it.each(["CONVERSATION_BUSY", "IDEMPOTENCY_CONFLICT", "CONVERSATION_NOT_ACTIVE"] as const)("发送消息的 %s 返回 409", async (code) => {
    mocks.service.sendMessage.mockRejectedValue(new LearningAssistantApplicationError(code));
    const response = await sendMessage(request(`/conversations/${conversationId}/messages`, '{"content":"测试"}'), conversationContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("没有归属的会话、消息和运行统一返回 404", async () => {
    mocks.service.getConversation.mockRejectedValue(new LearningAssistantApplicationError("CONVERSATION_NOT_FOUND"));
    mocks.service.listMessages.mockRejectedValue(new LearningAssistantApplicationError("CONVERSATION_NOT_FOUND"));
    mocks.service.getRun.mockRejectedValue(new LearningAssistantApplicationError("RUN_NOT_FOUND"));
    const responses = await Promise.all([
      getConversation(request(`/conversations/${conversationId}`), conversationContext),
      listMessages(request(`/conversations/${conversationId}/messages`), conversationContext),
      getRun(request(`/runs/${runId}`), runContext),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it("公开响应不暴露内部状态、工具载荷、运行摘要和原始错误", async () => {
    mocks.service.listMessages.mockResolvedValue({ items: [{
      ...message, role: "tool", content: "内部工具内容", toolName: "get_user_profile",
      toolResultJson: { private_memory: "长期记忆" },
    }], nextAfterSequenceNo: 25 });
    mocks.service.getRun.mockResolvedValue({ ...run, status: "failed", errorCode: "UPSTREAM_FAILURE", errorSummary: "数据库凭证" });
    const conversationBody = await (await getConversation(request(`/conversations/${conversationId}`), conversationContext)).json();
    const messageBody = await (await listMessages(request(`/conversations/${conversationId}/messages`), conversationContext)).json();
    const runBody = await (await getRun(request(`/runs/${runId}`), runContext)).json();
    expect(conversationBody).not.toHaveProperty("state");
    expect(conversationBody).not.toHaveProperty("owner_id");
    expect(messageBody).toMatchObject({ items: [{ role: "tool", content: null }], next_after_sequence_no: 25 });
    expect(messageBody.items[0]).not.toHaveProperty("tool_result");
    expect(messageBody.items[0]).not.toHaveProperty("metadata");
    expect(runBody).not.toHaveProperty("input_summary");
    expect(runBody).not.toHaveProperty("sub_agent_summary");
    expect(runBody.error_summary).not.toContain("数据库凭证");
  });

  it("续期 Session 写回响应，未知错误只返回通用 500", async () => {
    mocks.getCurrentUser.mockResolvedValue({ user: { id: ownerId }, renewedSessionExpiresAt: new Date(Date.now() + 60_000) });
    const response = await listConversations(request("/conversations"));
    expect(response.headers.get("set-cookie")).toContain("lc_session=test-session");
    mocks.service.getRun.mockRejectedValue(new Error("内部异常"));
    const failed = await getRun(request(`/runs/${runId}`), runContext);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
