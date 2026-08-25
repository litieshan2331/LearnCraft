/**
 * 学习路线生成接口的 Zod 请求契约。
 *
 * 导出：
 * - planGenerationRequestSchema：校验用户确认生成路线时不携带额外字段。
 */

import { z } from "zod";

export const planGenerationRequestSchema = z.object({}).strict();