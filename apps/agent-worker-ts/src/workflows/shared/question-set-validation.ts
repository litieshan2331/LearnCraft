/**
 * 题集校验与元数据映射（自原 shared/question-set-pipeline.ts 的校验部分拆出，
 * 由 assessment-generate 与 posttest-generate 共用）。
 *
 * 职责：
 * - validateQuestionSet：剥离围栏后解析题集，按题集合同严格校验并核对题量，
 *   失败时只返回脱敏的字段路径（绝不记录模型正文）；
 * - searchExtractLabel：按工具调用数生成 search_extract 元数据值，取值与 Python 一致；
 * - recoveryStageLabel：把 ReAct 会话结果映射为语义兼容的 recovery_stage 元数据值
 *   （键与取值集合都不变，Web 无需改动）。
 *
 * 导出：
 * - QuestionSetValidateResult / validateQuestionSet
 * - searchExtractLabel
 * - RecoveryStageName / recoveryStageLabel
 */

import {
  AssessmentQuestionSetSchema,
  extractJsonText,
  type AssessmentQuestionSet,
} from '../../schemas/assessment-question-set.js';

export interface QuestionSetValidateResult {
  value: AssessmentQuestionSet | null;
  paths: string[];
}

/** 解析并校验题集；失败时返回字段路径，且绝不记录模型正文。 */
export function validateQuestionSet(
  content: string,
  expectedQuestionCount: number,
): QuestionSetValidateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch {
    return { value: null, paths: ['response.json'] };
  }
  const parsed = AssessmentQuestionSetSchema.safeParse(raw);
  if (!parsed.success) {
    const paths: string[] = [];
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((segment) => String(segment)).join('.');
      const effective = path.length > 0 ? path : 'response.json';
      if (!paths.includes(effective)) {
        paths.push(effective);
      }
    }
    return { value: null, paths: paths.length > 0 ? paths : ['response.json'] };
  }
  if (parsed.data.questions.length !== expectedQuestionCount) {
    return { value: null, paths: ['questions'] };
  }
  return { value: parsed.data, paths: [] };
}

/** 按工具调用数生成 search_extract 元数据值（与 Python 的 assessment_generate 一致）。 */
export function searchExtractLabel(toolCallCount: number): string {
  return toolCallCount > 0 ? 'tavily_search_then_extract' : 'not_used';
}

export type RecoveryStageName = 'initial' | 'repair' | 'tavily_recovery';

/**
 * 把 ReAct 会话结果映射为 recovery_stage：
 * 用过联网工具 → tavily_recovery；未用过工具且首轮即通过 → initial；其余（同一会话内自纠通过）→ repair。
 */
export function recoveryStageLabel(outcome: {
  toolCallCount: number;
  validationFailures: number;
}): RecoveryStageName {
  if (outcome.toolCallCount > 0) {
    return 'tavily_recovery';
  }
  return outcome.validationFailures === 0 ? 'initial' : 'repair';
}
