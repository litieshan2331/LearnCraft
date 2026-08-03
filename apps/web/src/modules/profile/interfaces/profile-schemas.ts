/**
 * Profile HTTP 请求的 Zod 输入契约。
 *
 * 导出：
 * - learnerProfileUpsertRequestSchema：校验画像保存请求。
 * - learningGoalCreateRequestSchema：校验用户自定义主题的学习目标创建请求。
 * - learningGoalPathSchema、idempotencyKeySchema：校验目标路由参数和幂等键。
 */

import { z } from "zod";

const currentLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
const contentPreferenceSchema = z.enum(["document_first", "video_first", "balanced"]);
const operatingSystemSchema = z.enum(["windows", "macos", "linux", "other"]);
const optionalDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "截止日期必须使用 YYYY-MM-DD 格式。")
  .refine(isCalendarDate, "截止日期不是有效日期。");

export const learnerProfileUpsertRequestSchema = z.object({
  current_level: currentLevelSchema,
  weekly_minutes: z.number().int().min(30, "每周学习时间至少为 30 分钟。").max(10080, "每周学习时间不能超过 10080 分钟。"),
  operating_system: operatingSystemSchema.nullable().optional().transform((value) => value ?? null),
  background_summary: z.string().trim().max(2000, "学习背景不能超过 2000 个字符。").optional()
    .transform((value) => value || null),
  content_preference: contentPreferenceSchema,
}).strict();

export const learningGoalCreateRequestSchema = z.object({
  topic: z.string().trim().min(1, "学习主题不能为空。").max(200, "学习主题不能超过 200 个字符。"),
  title: z.string().trim().min(1, "学习目标标题不能为空。").max(200, "学习目标标题不能超过 200 个字符。"),
  description: z.string().trim().min(1, "请说明你想学习什么。").max(4000, "学习说明不能超过 4000 个字符。"),
  desired_outcome: z.string().trim().min(1, "请填写期望学习成果。").max(2000, "期望成果不能超过 2000 个字符。"),
  target_date: optionalDateSchema.nullable().optional().transform((value) => value ?? null),
  weekly_minutes_override: z.number().int().min(30, "每周学习时间至少为 30 分钟。").max(10080, "每周学习时间不能超过 10080 分钟。").nullable().optional()
    .transform((value) => value ?? null),
  model_connection_id: z.uuid("模型连接 ID 必须是 UUID。").nullable().optional().transform((value) => value ?? null),
}).strict();

export const learningGoalPathSchema = z.object({
  goal_id: z.uuid("学习目标 ID 必须是 UUID。"),
});

export const idempotencyKeySchema = z.uuid("Idempotency-Key 必须是 UUID。");

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
