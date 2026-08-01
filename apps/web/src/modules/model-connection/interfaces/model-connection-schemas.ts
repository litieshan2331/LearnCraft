/**
 * 用户模型连接 HTTP 请求的 Zod 输入契约。
 *
 * 导出：
 * - createModelConnectionRequestSchema：校验新建 OpenAI-compatible 连接请求。
 * - updateModelConnectionRequestSchema：校验连接的可选更新字段。
 * - modelConnectionPathSchema：校验模型连接 UUID 路径参数。
 */

import { z } from "zod";

const displayNameSchema = z.string().trim()
  .min(1, "连接名称不能为空。")
  .max(80, "连接名称不能超过 80 个字符。");
const baseUrlSchema = z.string().trim()
  .min(1, "Base URL 不能为空。")
  .max(2048, "Base URL 不能超过 2048 个字符。");
const apiKeySchema = z.string().trim()
  .min(1, "API Key 不能为空。")
  .max(4096, "API Key 不能超过 4096 个字符。");
const modelIdSchema = z.string().trim()
  .min(1, "模型名不能为空。")
  .max(255, "模型名不能超过 255 个字符。");

export const createModelConnectionRequestSchema = z.object({
  display_name: displayNameSchema,
  base_url: baseUrlSchema,
  api_key: apiKeySchema,
  default_model_id: modelIdSchema,
  set_as_default: z.boolean().default(true),
}).strict();

export const updateModelConnectionRequestSchema = z.object({
  display_name: displayNameSchema.optional(),
  base_url: baseUrlSchema.optional(),
  api_key: apiKeySchema.optional(),
  default_model_id: modelIdSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "至少提供一个需要更新的字段。",
});

export const modelConnectionPathSchema = z.object({
  model_connection_id: z.uuid("模型连接 ID 必须是 UUID。"),
});
