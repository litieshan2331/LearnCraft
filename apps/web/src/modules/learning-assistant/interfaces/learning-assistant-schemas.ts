/**
 * 学习助手 HTTP 请求的 Zod 契约。
 *
 * 调用顺序：Route Handler 读取路径、请求体或查询参数 → 使用本文件的 Schema 校验 →
 * 将 snake_case 字段映射为应用服务需要的 camelCase 输入。
 */

import { z } from "zod";

import { LEARNING_ASSISTANT_MESSAGE_PAGE_LIMIT } from "../application/learning-assistant-service";

const uuid = z.uuid().toLowerCase();
const sequence = z.coerce.number().int().min(0).max(2_147_483_647);
const pageLimit = z.coerce.number().int().min(1).max(200);

export const conversationPathSchema = z.object({
  conversation_id: uuid,
});

export const runPathSchema = z.object({
  run_id: uuid,
});

export const createConversationRequestSchema = z.object({
  goal_id: uuid.nullable().optional().transform((value) => value ?? null),
  source_assessment_answer_id: uuid.nullable().optional().transform((value) => value ?? null),
}).strict();

export const sendMessageRequestSchema = z.object({
  content: z.string().max(20_000, "消息内容不能超过 20000 个字符。")
    .refine((value) => value.trim().length > 0, "消息内容不能为空。"),
}).strict();

export const sendMessageHeadersSchema = z.object({
  "Idempotency-Key": z.uuid("请提供合法的 UUID 幂等键。").toLowerCase(),
});

/** 校验会话列表查询参数。 */
export function parseConversationListQuery(searchParams: URLSearchParams) {
  return z.object({
    limit: pageLimit.default(50),
  }).safeParse({
    limit: searchParams.get("limit") ?? undefined,
  });
}

/** 校验消息历史的序号游标和页大小。 */
export function parseMessageListQuery(searchParams: URLSearchParams) {
  return z.object({
    afterSequenceNo: sequence.default(0),
    limit: z.coerce.number().int().min(1).max(LEARNING_ASSISTANT_MESSAGE_PAGE_LIMIT).default(100),
  }).safeParse({
    afterSequenceNo: searchParams.get("after_sequence_no") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
}
