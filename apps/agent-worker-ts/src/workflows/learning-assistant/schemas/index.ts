/**
 * 学习助手运行身份、委派参数和只读工具合同。
 * 调用顺序：运行输入校验 → 委派参数校验 → 子 Agent 可信上下文校验 → 业务工具参数校验。
 */
import { z } from 'zod';

export const IntentSchema = z.enum(['wrong_answer_analysis', 'socratic_followup', 'review', 'programming']);
export const StageSchema = z.enum(['new', 'context_loaded', 'diagnosing', 'waiting_for_user', 'hinting', 'checking_repair', 'mastered', 'needs_more_practice', 'unresolved']);
export type Intent = z.infer<typeof IntentSchema>;
export type Stage = z.infer<typeof StageSchema>;
export const ActorSchema = z.enum(['main', 'error_attribution', 'socratic_tutor']);
export type Actor = z.infer<typeof ActorSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['user_message', 'assessment_answer', 'tool_result', 'external_source']),
  source_id: z.string().min(1),
  content: z.string().min(1),
  turn_no: z.number().int().positive().nullable(),
  executed: z.boolean(),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
export const RunInputSchema = z.object({
  run_id: z.uuid(), conversation_id: z.uuid(), owner_id: z.uuid(),
  connection_id: z.uuid(), model_id: z.string().min(1),
  message: z.object({ id: z.uuid(), turn_no: z.number().int().positive(), content: z.string().min(1).max(20000) }).strict(),
  question_id: z.uuid().nullable(),
}).strict();
export type RunInput = z.infer<typeof RunInputSchema>;
export const DelegateInputSchema = z.object({ task: z.string().trim().min(1).max(4000) }).strict();
export const ChildAgentInputSchema = z.object({
  requested_task: z.string().trim().min(1).max(4000),
  user_explanation: z.string().min(1).max(20000),
  wrong_question: z.record(z.string(), z.unknown()).nullable(),
  user_profile: z.record(z.string(), z.unknown()).nullable(),
  mastery_state: z.record(z.string(), z.unknown()).nullable(),
  diagnosis_text: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  hint_level: z.number().int().min(0).max(3),
  pending_question: z.string().max(2_000).nullable(),
  next_verification_target: z.string().nullable(),
}).strict();
export const BusinessToolNameSchema = z.enum(['get_wrong_question', 'get_user_profile', 'get_mastery_state']);
export type BusinessToolName = z.infer<typeof BusinessToolNameSchema>;
export const BusinessArgumentsSchema = z.object({}).strict();
export const SkillArgumentsSchema = z.object({
  skill_id: z.string().min(1).max(100),
  reference_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
}).strict();
export const BusinessResultSchema = z.object({
  data: z.record(z.string(), z.unknown()), evidence: z.array(EvidenceSchema),
}).strict();
export type BusinessResult = z.infer<typeof BusinessResultSchema>;
