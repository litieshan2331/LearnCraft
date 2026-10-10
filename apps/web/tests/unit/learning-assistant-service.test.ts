/**
 * 学习助手应用服务的行为测试。
 *
 * 调用顺序：构造领域端口替身 → 调用应用服务 → 验证归属检查、历史分页、幂等结果和错误映射。
 * 不连接数据库或模型；真实持久化事务由 Repository 集成测试覆盖。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LearningAssistantService } from "../../src/modules/learning-assistant/application/learning-assistant-service";
import { LearningAssistantRepositoryError, type MessageSnapshot } from "../../src/modules/learning-assistant/domain/learning-assistant";

const ownerId = "11111111-2222-4333-8444-555555555555";
const conversationId = "66666666-7777-4888-9999-000000000000";
const repository = {
  createConversation: vi.fn(),
  findOwnedConversation: vi.fn(),
  listOwnedConversations: vi.fn(),
  listOwnedMessages: vi.fn(),
  createQueuedRun: vi.fn(),
  findOwnedRun: vi.fn(),
  findInFlightRun: vi.fn(),
};
const service = new LearningAssistantService(repository);

/** 生成带序号的完整消息快照，便于验证分页不会丢失轮次或工具消息。 */
function message(sequenceNo: number): MessageSnapshot {
  return {
    id: String(sequenceNo), conversationId, sequenceNo, turnNo: Math.ceil(sequenceNo / 2),
    role: "user", content: `消息 ${sequenceNo}`, toolName: null, toolCallId: null,
    toolInputJson: {}, toolResultJson: {}, metadataJson: {}, createdAt: new Date("2026-10-10T00:00:00Z"),
  };
}

describe("学习助手应用服务", () => {
  // 为每个用例重置端口结果，避免所有权或分页状态串扰。
  beforeEach(() => {
    vi.resetAllMocks();
    repository.findOwnedConversation.mockResolvedValue({ id: conversationId, ownerId });
    repository.findInFlightRun.mockResolvedValue(null);
  });

  it("会话不存在时不读取消息或在途运行", async () => {
    repository.findOwnedConversation.mockResolvedValue(null);
    await expect(service.listMessages(ownerId, conversationId)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await expect(service.getConversation(ownerId, conversationId)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    expect(repository.listOwnedMessages).not.toHaveBeenCalled();
    expect(repository.findInFlightRun).not.toHaveBeenCalled();
  });

  it("会话详情带出在途运行，页面刷新后能够恢复处理状态", async () => {
    repository.findInFlightRun.mockResolvedValue({ id: "active-run", status: "queued" });
    expect(await service.getConversation(ownerId, conversationId)).toMatchObject({ activeRun: { id: "active-run" } });
    expect(repository.findInFlightRun).toHaveBeenCalledWith(ownerId, conversationId);
  });

  it("100 条页面上限只多读一条，不超过 Repository 的 200 条上限", async () => {
    repository.listOwnedMessages.mockResolvedValue(Array.from({ length: 101 }, (_, index) => message(index + 1)));
    const first = await service.listMessages(ownerId, conversationId, { limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextAfterSequenceNo).toBe(100);
    expect(repository.listOwnedMessages).toHaveBeenCalledWith(ownerId, conversationId, { afterSequenceNo: 0, limit: 101 });
    repository.listOwnedMessages.mockResolvedValue([message(101)]);
    const second = await service.listMessages(ownerId, conversationId, { limit: 100, afterSequenceNo: 100 });
    expect(second.items.map((item) => item.sequenceNo)).toEqual([101]);
    expect(second.nextAfterSequenceNo).toBeNull();
  });

  it("超过 20 轮的消息仍可逐页读取，末页和空页的游标为 null", async () => {
    const history = Array.from({ length: 60 }, (_, index) => message(index + 1));
    repository.listOwnedMessages.mockImplementation(async (_owner, _conversation, options) => (
      history.filter((item) => item.sequenceNo > options.afterSequenceNo).slice(0, options.limit)
    ));
    const first = await service.listMessages(ownerId, conversationId, { limit: 30 });
    const second = await service.listMessages(ownerId, conversationId, { limit: 30, afterSequenceNo: first.nextAfterSequenceNo! });
    expect([...first.items, ...second.items]).toEqual(history);
    expect(second.nextAfterSequenceNo).toBeNull();
    expect(await service.listMessages(ownerId, conversationId, { afterSequenceNo: 60 })).toEqual({ items: [], nextAfterSequenceNo: null });
  });

  it.each([0, -1, 101, 1.5])("非法页大小 %s 不调用消息查询", async (limit) => {
    await expect(service.listMessages(ownerId, conversationId, { limit })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repository.listOwnedMessages).not.toHaveBeenCalled();
  });

  it("发送消息保留代码缩进，并返回 Repository 的幂等结果", async () => {
    const result = { created: false, message: message(1), run: { id: "run", status: "queued" } };
    repository.createQueuedRun.mockResolvedValue(result);
    const input = { ownerId, conversationId, idempotencyKey: "key", content: "  const value = 1;\n" };
    expect(await service.sendMessage(input)).toBe(result);
    expect(repository.createQueuedRun).toHaveBeenCalledWith({
      ...input, orchestrationVersion: "learning-assistant-mvp-v1",
    });
    expect(repository.findOwnedConversation).not.toHaveBeenCalled();
  });

  it.each(["CONVERSATION_BUSY", "IDEMPOTENCY_CONFLICT", "CONVERSATION_NOT_ACTIVE"] as const)("映射 %s 错误", async (code) => {
    repository.createQueuedRun.mockRejectedValue(new LearningAssistantRepositoryError(code));
    await expect(service.sendMessage({ ownerId, conversationId, idempotencyKey: "key", content: "测试" })).rejects.toMatchObject({
      name: "LearningAssistantApplicationError", code,
    });
  });

  it("其他用户运行和不存在的运行统一不可读取", async () => {
    repository.findOwnedRun.mockResolvedValue(null);
    await expect(service.getRun(ownerId, "run")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(repository.findOwnedRun).toHaveBeenCalledWith(ownerId, "run");
  });
});
