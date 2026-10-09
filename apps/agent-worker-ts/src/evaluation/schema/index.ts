/**
 * 独立 Agent 评测文件的运行时契约。
 *
 * 调用顺序：评测运行器先用评测集契约读取 cases，再用单次结果契约校验每条 Judge 输出，
 * 最后用汇总报告契约校验落盘的整体结果；本文件只负责 Zod 校验和类型导出，不执行评测。
 *
 * 导出：
 * - EvaluationDatasetSchema：评测集文件契约。
 * - EvaluationCaseResultSchema：单条评测结果契约。
 * - EvaluationReportSchema：汇总报告契约。
 * - 五维评分和工作流相关的共享契约与 TypeScript 类型。
 */

import { z } from 'zod';

/** 评测运行器支持的四个业务工作流。 */
export const EvaluationRunTypeSchema = z.enum([
  'assessment_generate',
  'plan_generate',
  'card_content_generate',
  'posttest_generate',
]);

/** 五个质量评分维度，键名与评测结果 JSON 保持一致。 */
export const EvaluationDimensionSchema = z.enum([
  'correctness',
  'completeness',
  'relevance',
  'readability',
  'teaching_adaptation',
]);

/** 评测集中的一个维度评分说明。 */
export const EvaluationRubricSchema = z
  .object({
    correctness: z.string().min(1),
    completeness: z.string().min(1),
    relevance: z.string().min(1),
    readability: z.string().min(1),
    teaching_adaptation: z.string().min(1),
  })
  .strict();

/** 评测集的一条输入用例。 */
export const EvaluationCaseSchema = z
  .object({
    case_id: z.string().min(1).max(200),
    dataset_version: z.string().min(1).max(100),
    run_type: EvaluationRunTypeSchema,
    input_snapshot: z.record(z.string(), z.unknown()),
    learner_profile: z.record(z.string(), z.unknown()).default({}),
    reference_facts: z.array(z.string().min(1)).default([]),
    required_knowledge_points: z.array(z.string().min(1)).min(1),
    acceptable_answer_points: z.array(z.string().min(1)).min(1),
    scoring_rubric: EvaluationRubricSchema,
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** 评测集文件契约。 */
export const EvaluationDatasetSchema = z
  .object({
    schema_version: z.literal('agent_eval.dataset.v1'),
    dataset_version: z.string().min(1).max(100),
    cases: z.array(EvaluationCaseSchema).min(1),
  })
  .strict();

/** Judge 对单个质量维度的评分、理由和证据。 */
export const EvaluationDimensionScoreSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    reason: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** Judge 返回的五维评分对象。 */
export const EvaluationScoresSchema = z
  .object({
    correctness: EvaluationDimensionScoreSchema,
    completeness: EvaluationDimensionScoreSchema,
    relevance: EvaluationDimensionScoreSchema,
    readability: EvaluationDimensionScoreSchema,
    teaching_adaptation: EvaluationDimensionScoreSchema,
  })
  .strict();

/** 单条评测结果的结构前置检查结果。 */
export const EvaluationStructureCheckSchema = z
  .object({
    passed: z.boolean(),
    errors: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** 单条评测结果契约。 */
export const EvaluationCaseResultSchema = z
  .object({
    schema_version: z.literal('agent_eval.case_result.v1'),
    run_id: z.string().min(1).max(200),
    case_id: z.string().min(1).max(200),
    owner_id: z.uuid(),
    run_type: EvaluationRunTypeSchema,
    business_model: z
      .object({
        connection_id: z.string().min(1),
        model_id: z.string().min(1),
      })
      .strict(),
    judge_model: z.string().min(1),
    candidate_output: z.unknown(),
    structure_check: EvaluationStructureCheckSchema,
    scores: EvaluationScoresSchema.nullable(),
    weighted_score: z.number().min(1).max(5).nullable(),
    percentage_score: z.number().min(20).max(100).nullable(),
    status: z.enum(['scored', 'invalid', 'failed']),
    error: z.string().min(1).nullable(),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
  })
  .strict();

/** 汇总报告中的单条结果索引。 */
export const EvaluationReportCaseSchema = z
  .object({
    case_id: z.string().min(1).max(200),
    status: z.enum(['scored', 'invalid', 'failed']),
    weighted_score: z.number().min(1).max(5).nullable(),
    percentage_score: z.number().min(20).max(100).nullable(),
  })
  .strict();

/** 汇总报告中的五维平均分。 */
export const EvaluationDimensionAveragesSchema = z
  .object({
    correctness: z.number().min(1).max(5).nullable(),
    completeness: z.number().min(1).max(5).nullable(),
    relevance: z.number().min(1).max(5).nullable(),
    readability: z.number().min(1).max(5).nullable(),
    teaching_adaptation: z.number().min(1).max(5).nullable(),
  })
  .strict();

/** 独立评测运行的汇总报告契约。 */
export const EvaluationReportSchema = z
  .object({
    schema_version: z.literal('agent_eval.report.v1'),
    run_id: z.string().min(1).max(200),
    owner_id: z.uuid(),
    dataset_version: z.string().min(1).max(100),
    judge_model: z.string().min(1),
    total_cases: z.number().int().nonnegative(),
    scored_cases: z.number().int().nonnegative(),
    invalid_cases: z.number().int().nonnegative(),
    failed_cases: z.number().int().nonnegative(),
    dimension_averages: EvaluationDimensionAveragesSchema,
    weighted_average: z.number().min(1).max(5).nullable(),
    percentage_average: z.number().min(20).max(100).nullable(),
    cases: z.array(EvaluationReportCaseSchema),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
  })
  .strict();

/** 业务模型运行阶段的单条候选结果契约。 */
export const EvaluationRunCaseResultSchema = z
  .object({
    schema_version: z.literal('agent_eval.run_case.v1'),
    run_id: z.string().min(1).max(200),
    case_id: z.string().min(1).max(200),
    owner_id: z.uuid(),
    run_type: EvaluationRunTypeSchema,
    business_model: z
      .object({
        connection_id: z.string().min(1),
        model_id: z.string().min(1),
      })
      .strict(),
    candidate_output: z.unknown(),
    structure_check: EvaluationStructureCheckSchema,
    output_summary: z.record(z.string(), z.unknown()).nullable(),
    status: z.enum(['completed', 'invalid', 'failed']),
    error: z.string().min(1).nullable(),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
  })
  .strict();

/** 运行阶段汇总报告中的单条文件索引。 */
export const EvaluationRunReportCaseSchema = z
  .object({
    case_id: z.string().min(1).max(200),
    status: z.enum(['completed', 'invalid', 'failed']),
    file_name: z.string().min(1).max(300),
  })
  .strict();

/** 业务模型运行阶段的汇总报告契约。 */
export const EvaluationRunReportSchema = z
  .object({
    schema_version: z.literal('agent_eval.run_report.v1'),
    run_id: z.string().min(1).max(200),
    owner_id: z.uuid(),
    dataset_version: z.string().min(1).max(100),
    total_cases: z.number().int().nonnegative(),
    completed_cases: z.number().int().nonnegative(),
    invalid_cases: z.number().int().nonnegative(),
    failed_cases: z.number().int().nonnegative(),
    cases: z.array(EvaluationRunReportCaseSchema),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
  })
  .strict();

export type EvaluationRunType = z.infer<typeof EvaluationRunTypeSchema>;
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;
export type EvaluationDimensionScore = z.infer<typeof EvaluationDimensionScoreSchema>;
export type EvaluationStructureCheck = z.infer<typeof EvaluationStructureCheckSchema>;
export type EvaluationScores = z.infer<typeof EvaluationScoresSchema>;
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResultSchema>;
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
export type EvaluationRunCaseResult = z.infer<typeof EvaluationRunCaseResultSchema>;
export type EvaluationRunReport = z.infer<typeof EvaluationRunReportSchema>;
