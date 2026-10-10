/**
 * 学习助手应用结果的公开 JSON 映射器。
 *
 * 调用顺序：Route Handler 获取应用服务快照 → 调用本文件 presenter → 返回 snake_case
 * HTTP 响应；内部 ownerId、原始错误和数据库字段不会直接暴露。
 */

import type {
  ConversationSnapshot,
  MessageSnapshot,
  RunSnapshot,
} from "../domain/learning-assistant";

/** 将会话快照转换为公开响应。 */
export function presentConversation(conversation: ConversationSnapshot) {
  return {
    id: conversation.id,
    goal_id: conversation.goalId,
    source_assessment_answer_id: conversation.sourceAssessmentAnswerId,
    status: conversation.status,
    stage: conversation.stage,
    last_message_at: conversation.lastMessageAt?.toISOString() ?? null,
    created_at: conversation.createdAt.toISOString(),
    updated_at: conversation.updatedAt.toISOString(),
  };
}

/** 返回对话文本和稳定消息序号；工具消息只返回定位字段，内部载荷仍保存在服务端。 */
export function presentMessage(message: MessageSnapshot) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sequence_no: message.sequenceNo,
    turn_no: message.turnNo,
    role: message.role,
    content: message.role === "tool" ? null : message.content,
    created_at: message.createdAt.toISOString(),
  };
}

/** 将运行快照转换为状态查询响应。 */
export function presentRun(run: RunSnapshot) {
  return {
    id: run.id,
    conversation_id: run.conversationId,
    trigger_message_id: run.triggerMessageId,
    status: run.status,
    orchestration_version: run.orchestrationVersion,
    model_id: run.modelId,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    model_call_count: run.modelCallCount,
    tool_call_count: run.toolCallCount,
    error_code: run.errorCode,
    error_summary: run.status === "failed" ? "本次回复生成失败，请稍后重试。" : null,
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  };
}
