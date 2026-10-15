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
 * - CardContentContextEnvelopeSchema / CardContentPitfallDebugSchema / PersistedCardContentEnvelopeSchema
 * - LearningAssistantContextEnvelopeSchema / LearningAssistantWriteEnvelopeSchema / LearningAssistantMemoryEnvelopeSchema
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

/** 与 Web 路由 card-content-context 的 pitfallDebugSchema 完全一致：strict 且三个字段都必填。 */
export const CardContentPitfallDebugSchema = z
  .object({
    title: z.string().min(1).max(300),
    cause: z.string().min(1).max(2_000),
    fix: z.string().min(1).max(2_000),
  })
  .strict();

export const CardContentContextEnvelopeSchema = z
  .object({
    plan_node_id: z.uuid(),
    card_content_id: z.uuid(),
    foundation: z.string().min(1).max(12_000),
    worked_example: z.record(z.string(), z.unknown()),
    pitfalls_debug: z.array(CardContentPitfallDebugSchema).min(1),
    teaching_memory: z.record(z.string(), z.unknown()),
  })
  .strict();

export const PersistedCardContentEnvelopeSchema = z
  .object({
    card_content_id: z.uuid(),
    status: z.string().min(1).max(20),
  })
  .strict();

const LearningAssistantToolCallSchema = z.object({
  id: z.string().min(1).max(150),
  name: z.string().min(1).max(100),
  arguments_json: z.string().max(20_000),
}).strict();

const LearningAssistantContextMessageSchema = z.object({
  id: z.uuid(),
  turn_no: z.number().int().positive(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().nullable(),
  tool_call_id: z.string().max(150).nullable(),
  name: z.string().max(100).nullable(),
  tool_calls: z.array(LearningAssistantToolCallSchema),
}).strict();

const LearningAssistantEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['user_message', 'assessment_answer', 'tool_result', 'external_source']),
  source_id: z.string().min(1),
  content: z.string().min(1).max(20_000),
  turn_no: z.number().int().positive().nullable(),
  executed: z.boolean(),
}).strict();

export const LearningAssistantContextEnvelopeSchema = z.object({
  run_id: z.uuid(),
  conversation_id: z.uuid(),
  owner_id: z.uuid(),
  question_id: z.uuid().nullable(),
  recent_messages: z.array(LearningAssistantContextMessageSchema),
  wrong_question: z.record(z.string(), z.unknown()).nullable(),
  user_profile: z.record(z.string(), z.unknown()).nullable(),
  mastery_state: z.record(z.string(), z.unknown()).nullable(),
  learning_context: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(LearningAssistantEvidenceSchema),
}).strict();

export const LearningAssistantWriteEnvelopeSchema = z.object({
  run_id: z.uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  message_ids: z.array(z.uuid()),
}).strict();

export const LearningAssistantMemoryEnvelopeSchema = z.object({
  accepted: z.boolean(),
  memory_id: z.uuid().nullable(),
  created: z.boolean(),
}).strict();

export type DefaultModelConnectionEnvelope = z.infer<typeof DefaultModelConnectionEnvelopeSchema>;
export type PersistedAssessmentEnvelope = z.infer<typeof PersistedAssessmentEnvelopeSchema>;
export type PersistedLearningPlanEnvelope = z.infer<typeof PersistedLearningPlanEnvelopeSchema>;
export type CardContentContextEnvelope = z.infer<typeof CardContentContextEnvelopeSchema>;
export type PersistedCardContentEnvelope = z.infer<typeof PersistedCardContentEnvelopeSchema>;
export type LearningAssistantContextEnvelope = z.infer<typeof LearningAssistantContextEnvelopeSchema>;
export type LearningAssistantWriteEnvelope = z.infer<typeof LearningAssistantWriteEnvelopeSchema>;
export type LearningAssistantMemoryEnvelope = z.infer<typeof LearningAssistantMemoryEnvelopeSchema>;
