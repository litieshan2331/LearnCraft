/**
 * 学习助手可信输入、Agent 输出和证据合同。
 * 调用顺序：运行输入校验 → 工具参数校验 → 子 Agent 输出及证据校验 → 主回复校验 → 服务端记忆验证。
 */
import { z } from 'zod';

export const IntentSchema = z.enum(['wrong_answer_analysis', 'socratic_followup', 'review', 'programming']);
export const StageSchema = z.enum(['new', 'context_loaded', 'diagnosing', 'waiting_for_user', 'hinting', 'checking_repair', 'mastered', 'needs_more_practice', 'unresolved']);
export const ActorSchema = z.enum(['main', 'error_attribution', 'socratic_tutor']);
export type Actor = z.infer<typeof ActorSchema>;

/** 问题正文只允许一个问号；语义上的复合问题另由提示词和验收约束。 */
function isSingleQuestion(value: string): boolean {
  const prose = visibleProse(value);
  return (prose.match(/[?？]/g) ?? []).length <= 1
    && !/(?:[;；\n]|(?:并且|同时|以及|还要|再)[，,\s]*)(?:请|解释|说明|列出|如何|为什么|怎么|能否)/.test(prose)
    && !/(?:^|\n)\s*(?:\d+[.、]|[-*])\s*\S+/.test(prose);
}
/** 去掉代码与链接再检查问句，避免把 TypeScript 可选字段、三元表达式当成提问。 */
function visibleProse(value: string): string {
  return value.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/https?:\/\/\S+/g, '');
}
/** 解释中不能另藏提问，问题必须放入独立结构字段。 */
function hasNoQuestion(value: string): boolean { return !/[?？]/.test(visibleProse(value)); }
export const PrimaryQuestionSchema = z.string().trim().min(1).max(2000).refine(isSingleQuestion, '只能包含一个主要问题');
export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['user_message', 'assessment_answer', 'tool_result', 'external_source']),
  source_id: z.string().min(1),
  content: z.string().min(1),
  turn_no: z.number().int().positive().nullable(),
  executed: z.boolean(),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
export const VerificationSchema = z.object({
  status: z.enum(['not_verified', 'model_evaluated', 'verified']),
  conclusion: z.string().max(3000),
  evidence_ids: z.array(z.string().min(1)),
  demonstrated_progress: z.boolean(),
}).strict();
export type Verification = z.infer<typeof VerificationSchema>;
export const AttributionSchema = z.object({
  status: z.enum(['hypothesis', 'insufficient_evidence']),
  hypotheses: z.array(z.object({
    error_type: z.enum(['concept_gap', 'reasoning_step', 'api_usage', 'boundary_case', 'careless_check']),
    explanation: z.string().min(1).max(3000),
    evidence_ids: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1),
  }).strict()).max(5),
  verification_direction: z.string().min(1).max(3000),
  verification: VerificationSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status === 'hypothesis' && value.hypotheses.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['hypotheses'], message: '归因假设必须包含来源证据' });
  }
  if (value.status === 'insufficient_evidence' && value.hypotheses.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['hypotheses'], message: '证据不足时不能同时确认错因假设' });
  }
});
export type Attribution = z.infer<typeof AttributionSchema>;
export const SocraticSchema = z.object({
  primary_question: PrimaryQuestionSchema,
  hint: z.string().max(3000).refine(hasNoQuestion, '提示中不能另藏提问'),
  hint_level: z.number().int().min(0).max(3),
  next_verification_target: z.string().min(1).max(3000),
  verification: VerificationSchema,
}).strict();
export type SocraticResponse = z.infer<typeof SocraticSchema>;
export const MainResponseSchema = z.object({
  intent: IntentSchema,
  explanation: z.string().trim().min(1).max(20000).refine(hasNoQuestion, '提问必须放入 primary_question'),
  primary_question: PrimaryQuestionSchema.nullable(),
  next_action: z.enum(['answer', 'await_user', 'practice', 'review', 'finish']),
  stage: StageSchema,
}).strict().superRefine((value, ctx) => {
  if (value.next_action === 'await_user' && value.primary_question === null) {
    ctx.addIssue({ code: 'custom', path: ['primary_question'], message: '等待回答需要一个主要问题' });
  }
});
export type MainResponse = z.infer<typeof MainResponseSchema>;
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
  learning_context: z.record(z.string(), z.unknown()).nullable(),
  diagnosis: AttributionSchema.nullable(),
  evidence: z.array(EvidenceSchema),
  hint_level: z.number().int().min(0).max(3),
  pending_question: PrimaryQuestionSchema.nullable(),
  next_verification_target: z.string().nullable(),
}).strict();
export const BusinessToolNameSchema = z.enum(['get_wrong_question', 'get_user_profile', 'get_mastery_state', 'get_learning_context']);
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

/** 子 Agent 只能引用服务端证据，不允许编造 ID 或通过置信度直接确认修复。 */
export function validateEvidenceReferences(output: Attribution | SocraticResponse, evidence: readonly Evidence[]): void {
  const ids = new Set(evidence.map((item) => item.id));
  const refs = [...output.verification.evidence_ids];
  if ('hypotheses' in output) refs.push(...output.hypotheses.flatMap((item) => item.evidence_ids));
  if (refs.some((id) => !ids.has(id))) throw new Error('子 Agent 引用了未提供的证据');
  if (output.verification.status !== 'not_verified' && refs.length === 0) throw new Error('验证结论缺少证据');
}

/** 将已校验的回复转成展示文本，避免重复输出主要问题。 */
export function renderMainResponse(value: MainResponse): string {
  return value.explanation + (value.primary_question === null ? '' : '\n\n' + value.primary_question);
}
