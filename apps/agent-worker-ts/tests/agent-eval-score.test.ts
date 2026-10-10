/**
 * 评分失败重试的离线测试，不调用数据库或真实模型。
 * 调用顺序：prepareRun 写入固定候选和已有评分；main 执行评分命令并使用假 Judge；
 * readReport 检查合并报告，随后核对成功文件保留、请求数量和错误输入行为。
 */
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/main/agent-eval.js';
import { writeEvaluationDataset } from '../src/evaluation/dataset.js';
import {
  buildEvaluationRunReport,
  writeEvaluationCaseResult,
  writeEvaluationRunCaseResult,
  writeEvaluationRunReport,
} from '../src/evaluation/report.js';
import {
  EvaluationCaseResultSchema,
  EvaluationReportSchema,
  EvaluationRunCaseResultSchema,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationScores,
} from '../src/evaluation/schema/index.js';

const fakeJudge = vi.hoisted(() => ({ scoreCandidate: vi.fn(), modelName: vi.fn() }));
vi.mock('../src/evaluation/judge.js', () => ({ createJudgeClient: () => fakeJudge }));

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const DATASET_VERSION = 'retry-offline-v1';
const STARTED_AT = '2026-10-10T00:00:00.000Z';
let outputDir: string;

/** 构造固定且合法的五维评分。 */
function fixedScores(score: number): EvaluationScores {
  const dimension = { score, reason: '固定离线理由。', evidence: ['candidate_output.questions'] };
  return {
    correctness: dimension,
    completeness: dimension,
    relevance: dimension,
    readability: dimension,
    teaching_adaptation: dimension,
  };
}

/** 写入成功、评分失败和结构无效三条用例，返回命令参数和文件路径。 */
async function prepareRun() {
  const cases: EvaluationCase[] = ['scored-case', 'failed-case', 'invalid-case'].map((caseId) => ({
    case_id: caseId,
    dataset_version: DATASET_VERSION,
    run_type: 'assessment_generate',
    input_snapshot: { topic: 'Python 基础' },
    learner_profile: {},
    reference_facts: ['列表是有序序列。'],
    required_knowledge_points: [],
    acceptable_answer_points: ['检查列表基础知识。'],
    scoring_rubric: {
      correctness: '事实正确。',
      completeness: '要求完整。',
      relevance: '目标相关。',
      readability: '表达清晰。',
      teaching_adaptation: '适配学习者。',
    },
    tags: [],
  }));
  const datasetPath = await writeEvaluationDataset(join(outputDir, 'dataset.json'), {
    schema_version: 'agent_eval.dataset.v1',
    dataset_version: DATASET_VERSION,
    cases,
  });
  const runs = cases.map((evaluationCase) => EvaluationRunCaseResultSchema.parse({
    schema_version: 'agent_eval.run_case.v1',
    run_id: 'run-' + evaluationCase.case_id,
    case_id: evaluationCase.case_id,
    owner_id: OWNER_ID,
    run_type: evaluationCase.run_type,
    business_model: { connection_id: 'offline-connection', model_id: 'offline-business' },
    candidate_output: { questions: [{ prompt: evaluationCase.case_id }] },
    structure_check: evaluationCase.case_id === 'invalid-case'
      ? { passed: false, errors: ['固定结构错误。'] }
      : { passed: true, errors: [] },
    output_summary: null,
    status: evaluationCase.case_id === 'invalid-case' ? 'invalid' : 'completed',
    error: evaluationCase.case_id === 'invalid-case' ? '固定结构错误。' : null,
    started_at: STARTED_AT,
    finished_at: STARTED_AT,
  }));
  const runPaths: string[] = [];
  const scorePaths: string[] = [];
  for (const run of runs) {
    runPaths.push(await writeEvaluationRunCaseResult(outputDir, run));
    const result = EvaluationCaseResultSchema.parse({
      schema_version: 'agent_eval.case_result.v1',
      run_id: run.run_id,
      case_id: run.case_id,
      owner_id: OWNER_ID,
      run_type: run.run_type,
      business_model: run.business_model,
      judge_model: 'offline-judge',
      candidate_output: run.candidate_output,
      structure_check: run.structure_check,
      scores: run.case_id === 'scored-case' ? fixedScores(2) : null,
      weighted_score: run.case_id === 'scored-case' ? 2 : null,
      percentage_score: run.case_id === 'scored-case' ? 40 : null,
      status: run.case_id === 'scored-case' ? 'scored' : run.case_id === 'failed-case' ? 'failed' : 'invalid',
      error: run.case_id === 'failed-case' ? '固定 Judge 超时。' : run.error,
      started_at: STARTED_AT,
      finished_at: STARTED_AT,
    });
    scorePaths.push(await writeEvaluationCaseResult(join(outputDir, 'scores'), result));
  }
  await writeEvaluationRunReport(outputDir, buildEvaluationRunReport({
    runId: 'offline-report',
    ownerId: OWNER_ID,
    datasetVersion: DATASET_VERSION,
    results: runs,
    fileNames: runs.map((run) => run.run_id + '-' + run.case_id + '.json'),
    startedAt: STARTED_AT,
  }));
  return {
    args: ['score', '--owner-id', OWNER_ID, '--dataset', datasetPath, '--output', outputDir],
    runs,
    runPaths,
    scorePaths,
  };
}

/** 读取并校验实际落盘的汇总报告。 */
async function readReport() {
  return EvaluationReportSchema.parse(JSON.parse(await readFile(join(outputDir, 'scores', 'report.json'), 'utf8')) as unknown);
}

/** 修改指定旧评分字段，用于模拟模型变更或运行内容错配。 */
async function updateScore(path: string, changes: Partial<EvaluationCaseResult>) {
  const previous = JSON.parse(await readFile(path, 'utf8')) as EvaluationCaseResult;
  await writeFile(path, JSON.stringify({ ...previous, ...changes }), 'utf8');
}

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'learncraft-eval-retry-'));
  fakeJudge.scoreCandidate.mockReset().mockResolvedValue(fixedScores(4));
  fakeJudge.modelName.mockReset().mockReturnValue('offline-judge');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // 只清理本测试由 mkdtemp 创建并确认的临时目录。
  await rm(outputDir, { recursive: true, force: true });
});

describe('score --retry-failed', () => {
  it('只评分失败项，成功和无效文件保持原内容，报告合并全部用例', async () => {
    const fixture = await prepareRun();
    const scoredContent = await readFile(fixture.scorePaths[0]!, 'utf8');
    const invalidContent = await readFile(fixture.scorePaths[2]!, 'utf8');
    const runContents = await Promise.all(fixture.runPaths.map((path) => readFile(path, 'utf8')));

    await main([...fixture.args, '--retry-failed']);

    expect(fakeJudge.scoreCandidate).toHaveBeenCalledTimes(1);
    expect(fakeJudge.scoreCandidate.mock.calls[0]?.[0].evaluationCase.case_id).toBe('failed-case');
    expect(await readFile(fixture.scorePaths[0]!, 'utf8')).toBe(scoredContent);
    expect(await readFile(fixture.scorePaths[2]!, 'utf8')).toBe(invalidContent);
    expect(await Promise.all(fixture.runPaths.map((path) => readFile(path, 'utf8')))).toEqual(runContents);
    expect(await readReport()).toMatchObject({ total_cases: 3, scored_cases: 2, invalid_cases: 1, failed_cases: 0, weighted_average: 3, percentage_average: 60 });

    fakeJudge.scoreCandidate.mockClear();
    await main([...fixture.args, '--retry-failed']);
    expect(fakeJudge.scoreCandidate).not.toHaveBeenCalled();
    expect((await readReport()).total_cases).toBe(3);
  });

  it('重试仍失败时保留失败状态，平均分只使用原成功结果', async () => {
    const fixture = await prepareRun();
    fakeJudge.scoreCandidate.mockRejectedValue(new Error('固定 Judge 再次超时。'));
    await main([...fixture.args, '--retry-failed']);
    expect(fakeJudge.scoreCandidate).toHaveBeenCalledTimes(1);
    expect(await readReport()).toMatchObject({ total_cases: 3, scored_cases: 1, invalid_cases: 1, failed_cases: 1, weighted_average: 2 });
    expect(JSON.parse(await readFile(fixture.scorePaths[1]!, 'utf8'))).toMatchObject({ status: 'failed', error: '固定 Judge 再次超时。' });
  });

  it('缺少已有评分时在任何 Judge 请求前报错', async () => {
    const fixture = await prepareRun();
    await unlink(fixture.scorePaths[2]!);
    await expect(main([...fixture.args, '--retry-failed'])).rejects.toThrow('找不到已有评分');
    expect(fakeJudge.scoreCandidate).not.toHaveBeenCalled();
  });

  it('拒绝合并不同 Judge 模型的成功评分', async () => {
    const fixture = await prepareRun();
    fakeJudge.modelName.mockReturnValue('different-judge');
    await expect(main([...fixture.args, '--retry-failed'])).rejects.toThrow('当前 Judge 模型不一致');
    expect(fakeJudge.scoreCandidate).not.toHaveBeenCalled();
  });

  it('拒绝复用与当前运行或候选内容不匹配的评分', async () => {
    const fixture = await prepareRun();
    await updateScore(fixture.scorePaths[0]!, { run_id: 'different-run' });
    await expect(main([...fixture.args, '--retry-failed'])).rejects.toThrow('候选结果不一致');
    await updateScore(fixture.scorePaths[0]!, { run_id: fixture.runs[0]!.run_id, candidate_output: { questions: [] } });
    await expect(main([...fixture.args, '--retry-failed'])).rejects.toThrow('候选结果不一致');
    expect(fakeJudge.scoreCandidate).not.toHaveBeenCalled();
  });

  it('业务生成失败的候选不会发送 Judge 请求，报告继续记录失败', async () => {
    const fixture = await prepareRun();
    const run = { ...fixture.runs[1]!, status: 'failed' as const, candidate_output: null, structure_check: { passed: false, errors: ['固定生成失败。'] }, error: '固定生成失败。' };
    await writeEvaluationRunCaseResult(outputDir, run);
    await updateScore(fixture.scorePaths[1]!, { candidate_output: run.candidate_output, structure_check: run.structure_check, error: run.error });
    await main([...fixture.args, '--retry-failed']);
    expect(fakeJudge.scoreCandidate).not.toHaveBeenCalled();
    expect(await readReport()).toMatchObject({ scored_cases: 1, invalid_cases: 1, failed_cases: 1 });
  });

  it('普通 score 仍重新评分全部可评分候选并覆盖旧分数', async () => {
    const fixture = await prepareRun();
    await main(fixture.args);
    expect(fakeJudge.scoreCandidate).toHaveBeenCalledTimes(2);
    expect(await readReport()).toMatchObject({ total_cases: 3, scored_cases: 2, invalid_cases: 1, failed_cases: 0, weighted_average: 4 });
    expect(JSON.parse(await readFile(fixture.scorePaths[0]!, 'utf8')).weighted_score).toBe(4);
  });
});
