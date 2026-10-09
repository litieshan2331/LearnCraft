/**
 * Agent 评测结果与汇总报告的计算和落盘。
 *
 * 调用顺序：buildEvaluationReport 先筛选通过结构检查并成功评分的单次结果，再计算五维平均分、
 * 3/2/2/2/1 加权平均分和百分制平均分；writeEvaluationCaseResult 与 writeEvaluationReport
 * 创建目标目录并以临时文件替换方式写入 JSON。文件内容只来自已校验的评测结果，不写入模型 API Key。
 *
 * 导出：
 * - buildEvaluationReport：构造并校验汇总报告。
 * - writeEvaluationCaseResult：落盘单次评测结果。
 * - writeEvaluationReport：落盘汇总报告。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  EvaluationCaseResultSchema,
  EvaluationReportSchema,
  type EvaluationCaseResult,
  type EvaluationReport,
} from './schema/index.js';

/** 构造汇总报告所需的输入。 */
export interface EvaluationReportInput {
  runId: string;
  ownerId: string;
  datasetVersion: string;
  judgeModel: string;
  results: readonly EvaluationCaseResult[];
  startedAt: string;
  finishedAt?: string;
}

/** 按五个维度和固定权重计算汇总报告。 */
export function buildEvaluationReport(input: EvaluationReportInput): EvaluationReport {
  const validatedResults = input.results.map((result) => EvaluationCaseResultSchema.parse(result));
  const scored = validatedResults.filter(
    (result): result is EvaluationCaseResult & { scores: NonNullable<EvaluationCaseResult['scores']>; weighted_score: number } =>
      result.status === 'scored' && result.scores !== null && result.weighted_score !== null,
  );
  const dimensions = ['correctness', 'completeness', 'relevance', 'readability', 'teaching_adaptation'] as const;
  const dimensionAverages = Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    scored.length === 0 ? null : average(scored.map((result) => result.scores[dimension].score)),
  ])) as EvaluationReport['dimension_averages'];
  const weightedAverage = scored.length === 0 ? null : average(scored.map((result) => result.weighted_score));
  return EvaluationReportSchema.parse({
    schema_version: 'agent_eval.report.v1',
    run_id: input.runId,
    owner_id: input.ownerId,
    dataset_version: input.datasetVersion,
    judge_model: input.judgeModel,
    total_cases: validatedResults.length,
    scored_cases: scored.length,
    invalid_cases: validatedResults.filter((result) => result.status === 'invalid').length,
    failed_cases: validatedResults.filter((result) => result.status === 'failed').length,
    dimension_averages: dimensionAverages,
    weighted_average: weightedAverage,
    percentage_average: weightedAverage === null ? null : round((weightedAverage / 5) * 100),
    cases: validatedResults.map((result) => ({
      case_id: result.case_id,
      status: result.status,
      weighted_score: result.weighted_score,
      percentage_score: result.percentage_score,
    })),
    started_at: input.startedAt,
    finished_at: input.finishedAt ?? new Date().toISOString(),
  });
}

/** 将单条结果写入 outputDir，并返回实际文件路径。 */
export async function writeEvaluationCaseResult(
  outputDir: string,
  result: EvaluationCaseResult,
): Promise<string> {
  const parsed = EvaluationCaseResultSchema.parse(result);
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const safeCaseId = parsed.case_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(directory, parsed.run_id + '-' + safeCaseId + '.json');
  await writeJsonAtomically(path, parsed);
  return path;
}

/** 将汇总报告写入 outputDir/report.json，并返回实际文件路径。 */
export async function writeEvaluationReport(
  outputDir: string,
  report: EvaluationReport,
): Promise<string> {
  const parsed = EvaluationReportSchema.parse(report);
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'report.json');
  await writeJsonAtomically(path, parsed);
  return path;
}

/** 以临时文件加 rename 的方式写 JSON，避免进程中断留下半截结果。 */
async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = path + '.tmp-' + process.pid.toString(36) + '-' + Date.now().toString(36);
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temporaryPath, path);
  } finally {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(temporaryPath);
    } catch {
      // rename 成功后临时文件已经不存在；清理失败不覆盖主流程结果。
    }
  }
}

/** 计算数字平均值并保留四位小数。 */
function average(values: readonly number[]): number {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** 统一小数精度，避免报告中出现浮点尾数。 */
function round(value: number): number {
  return Number(value.toFixed(4));
}
