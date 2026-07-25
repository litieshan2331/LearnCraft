/**
 * Identity HTTP 请求的 Zod 输入契约。
 *
 * 导出：
 * - registerRequestSchema：注册请求的字段、长度和格式校验。
 * - loginRequestSchema：登录请求的字段、长度和格式校验。
 */

import { z } from "zod";

export const registerRequestSchema = z.object({
  email: z.string().trim().email("请输入有效的邮箱地址。").max(255, "邮箱不能超过 255 个字符。"),
  display_name: z.string().trim().min(1, "昵称不能为空。").max(120, "昵称不能超过 120 个字符。"),
  password: z.string().min(12, "密码至少需要 12 个字符。").max(128, "密码不能超过 128 个字符。"),
}).strict();

export const loginRequestSchema = z.object({
  email: z.string().trim().email("请输入有效的邮箱地址。").max(255, "邮箱不能超过 255 个字符。"),
  password: z.string().min(12, "密码至少需要 12 个字符。").max(128, "密码不能超过 128 个字符。"),
}).strict();
