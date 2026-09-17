/**
 * Web 内部接口的响应契约（zod 运行时校验）。
 *
 * 职责：把内部接口返回的 snake_case 数据在运行时校验为受信任类型；所有对象都是 strict，
 * 因为 Python 侧使用 extra="forbid"，多一个键就应判定为契约不符（CORE_INTERNAL_RESPONSE_INVALID）。
 *
 * 注意：zod v4 的 z.uuid() 会校验 RFC 版本号与变体位，比 Pydantic 的 UUID 更严格。
 * 数据库使用 gen_random_uuid() 生成合法 v4，因此正常数据不受影响；但若外部系统写入非标准 UUID，
 * 本实现会判定为契约不符（CORE_INTERNAL_RESPONSE_INVALID），而 Python 可能接受——属已知差异。
 *
 * 导出：
 * - EncryptedModelCredentialSchema / DefaultModelConnectionEnvelopeSchema
 * - PersistedAssessmentEnvelopeSchema / PersistedLearningPlanEnvelopeSchema
 * - CardContentContextEnvelopeSchema / PersistedCardContentEnvelopeSchema
 */

import { z } from 'zod';

export const EncryptedModelCredentialSchema = z
  .object({
    ciphertext_base64: z.string().min(1),
    iv_base64: z.string().min(1),
    auth_tag_base64: z.string().min(1),
    encryption_key_version: z.string().min(1).max(50),
  })
  .strict();

export const DefaultModelConnectionEnvelopeSchema = z
  .object({
    owner_id: z.uuid(),
    connection_id: z.uuid(),
    base_url: z.string().min(1).max(2_048),
    model_id: z.string().min(1).max(255),
    credential: EncryptedModelCredentialSchema,
  })
  .strict();

export const PersistedAssessmentEnvelopeSchema = z
  .object({
    assessment_id: z.uuid(),
    status: z.string().min(1).max(30),
    question_count: z.number().int().min(1).max(20),
  })
  .strict();

export const PersistedLearningPlanEnvelopeSchema = z
  .object({
    learning_plan_id: z.uuid(),
    node_count: z.number().int().min(6).max(12),
  })
  .strict();

export const CardContentContextEnvelopeSchema = z
  .object({
    plan_node_id: z.uuid(),
    card_content_id: z.uuid(),
    foundation: z.string().min(1).max(12_000),
    worked_example: z.record(z.string(), z.unknown()),
    pitfalls_debug: z.array(z.record(z.string(), z.string())).min(1),
    teaching_memory: z.record(z.string(), z.unknown()),
  })
  .strict();

export const PersistedCardContentEnvelopeSchema = z
  .object({
    card_content_id: z.uuid(),
    status: z.string().min(1).max(20),
  })
  .strict();

export type DefaultModelConnectionEnvelope = z.infer<typeof DefaultModelConnectionEnvelopeSchema>;
export type PersistedAssessmentEnvelope = z.infer<typeof PersistedAssessmentEnvelopeSchema>;
export type PersistedLearningPlanEnvelope = z.infer<typeof PersistedLearningPlanEnvelopeSchema>;
export type CardContentContextEnvelope = z.infer<typeof CardContentContextEnvelopeSchema>;
export type PersistedCardContentEnvelope = z.infer<typeof PersistedCardContentEnvelopeSchema>;
