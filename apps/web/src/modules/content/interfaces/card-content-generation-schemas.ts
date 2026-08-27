/**
 * 节点知识内容生成接口的 Zod 请求契约。
 *
 * 导出：
 * - cardContentGenerationRequestSchema：校验无额外参数的首次内容生成请求。
 */

import { z } from "zod";

export const cardContentGenerationRequestSchema = z.object({}).strict();

export type CardContentGenerationRequestBody = z.infer<typeof cardContentGenerationRequestSchema>;