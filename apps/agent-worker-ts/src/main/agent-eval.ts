/**
 * 独立 Agent 评测进程入口。
 *
 * 调用顺序：main 解析 build/run/score CLI；build 校验并标准化评测集，run 装配业务模型网关并保存候选结果，
 * score 读取候选结果后调用独立 Judge 并生成加权报告；--retry-failed 先校验并复用已有评分，再仅重试失败项。
 * 业务模型沿用现有受控出网网关；Judge 只使用
 * AGENT_EVAL_JUDGE_* 环境变量。
 */

import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import pg from 'pg';

import { readAgentReactMaxTurns, readModelEgressAuditRetentionDays, readModelEgressOptions, readModelGatewayRequestMaxRetries } from '../bootstrap/config.js';
import { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../infrastructure/llm/model-gateway.js';
import { PgModelEgressAuditRepository } from '../infrastructure/database/model-egress-audit-repository.js';
import { SafeModelEgressClient } from '../infrastructure/llm/safe-egress-client.js';
import {
  AgentEvalCliError,
  formatAgentEvalCliUsage,
  parseAgentEvalCommandArgs,
} from '../evaluation/cli.js';
import { createJudgeClient } from '../evaluation/judge.js';
import {
  runEvaluationCase,
  scoreEvaluationCaseWithJudge,
  PgOwnerModelConnectionReader,
  type EvaluationBusinessDeps,
} from '../evaluation/runner.js';
import { readEvaluationDataset, writeEvaluationDataset } from '../evaluation/dataset.js';
import {
  buildEvaluationRunReport,
  buildEvaluationReport,
  writeEvaluationCaseResult,
  writeEvaluationRunCaseResult,
  writeEvaluationRunReport,
  writeEvaluationReport,
} from '../evaluation/report.js';
import {
  EvaluationCaseResultSchema,
  EvaluationRunCaseResultSchema,
  EvaluationRunReportSchema,
  type EvaluationCaseResult,
  type EvaluationCase,
  type EvaluationRunCaseResult,
} from '../evaluation/schema/index.js';

/** 判断当前模块是否由 Node 作为独立进程入口直接执行。 */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/** 根据 build、run、score 三阶段命令执行评测流程。 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseAgentEvalCommandArgs(argv);
  if ('help' in parsed) {
    console.log(formatAgentEvalCliUsage());
    return;
  }
  if (parsed.command === 'build') {
    const dataset = await readEvaluationDataset(parsed.inputPath);
    const outputPath = await writeEvaluationDataset(parsed.datasetPath, dataset);
    console.log('[agent-eval] 评测集已构建并校验：' + outputPath);
    return;
  }
  if (parsed.ownerId === undefined) {
    throw new AgentEvalCliError('命令 ' + parsed.command + ' 缺少 --owner-id。');
  }
  if (parsed.command === 'run') {
    await runBusinessEvaluation(parsed.ownerId, parsed.datasetPath, parsed.outputDir);
    return;
  }
  await scoreBusinessEvaluation(parsed.ownerId, parsed.datasetPath, parsed.outputDir, parsed.retryFailed);
}

/** 必须配置数据库连接，以便读取 owner-id 默认模型并复用业务出网审计。 */
function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error('缺少必需的环境变量：DATABASE_URL');
  }
  return value;
}

/** 只调用业务模型并把候选结果写入 outputDir，供 score 阶段复用。 */
async function runBusinessEvaluation(
  ownerId: string,
  datasetPath: string,
  outputDir: string,
): Promise<void> {
  const dataset = await readEvaluationDataset(datasetPath);
  const pool = new pg.Pool({ connectionString: requireDatabaseUrl(), max: 8 });
  const startedAt = new Date().toISOString();
  const runId = 'agent-eval-' + Date.now().toString(36);
  const results: EvaluationRunCaseResult[] = [];
  const fileNames: string[] = [];
  try {
    const deps = createBusinessDeps(pool);
    for (const evaluationCase of dataset.cases) {
      const result = await runBusinessCase(ownerId, evaluationCase, deps, runId);
      const path = await writeEvaluationRunCaseResult(outputDir, result);
      results.push(result);
      fileNames.push(basename(path));
      console.log('[agent-eval] run case=' + result.case_id + ' status=' + result.status);
    }
  } finally {
    await pool.end();
  }
  const report = buildEvaluationRunReport({
    runId,
    ownerId,
    datasetVersion: dataset.dataset_version,
    results,
    fileNames,
    startedAt,
  });
  const reportPath = await writeEvaluationRunReport(outputDir, report);
  console.log('[agent-eval] 业务运行报告已写入：' + reportPath);
}

/** 执行单条业务工作流并转换为可落盘的候选结果。 */
async function runBusinessCase(
  ownerId: string,
  evaluationCase: EvaluationCase,
  deps: EvaluationBusinessDeps,
  runId: string,
): Promise<EvaluationRunCaseResult> {
  const startedAt = new Date().toISOString();
  try {
    // 出网审计表的 agent_run_id 是 PostgreSQL uuid；评测运行报告 ID 允许使用可读字符串，
    // 但传给现有业务工作流的运行 ID 必须保持 UUID，才能写入审计记录。
    const execution = await runEvaluationCase({ ownerId, evaluationCase, runId: randomUUID() }, deps);
    return EvaluationRunCaseResultSchema.parse({
      schema_version: 'agent_eval.run_case.v1',
      run_id: execution.runId,
      case_id: execution.caseId,
      owner_id: ownerId,
      run_type: execution.runType,
      business_model: execution.businessModel,
      candidate_output: execution.candidateOutput,
      structure_check: execution.structureCheck,
      output_summary: execution.outputSummary,
      status: execution.structureCheck.passed ? 'completed' : 'invalid',
      error: execution.structureCheck.passed ? null : '候选输出未通过结构合同校验。',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    return EvaluationRunCaseResultSchema.parse({
      schema_version: 'agent_eval.run_case.v1',
      run_id: runId + '-' + evaluationCase.case_id + '-' + randomUUID().slice(0, 8),
      case_id: evaluationCase.case_id,
      owner_id: ownerId,
      run_type: evaluationCase.run_type,
      business_model: { connection_id: 'unknown', model_id: 'unknown' },
      candidate_output: null,
      structure_check: { passed: false, errors: ['业务工作流执行失败。'] },
      output_summary: null,
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
  }
}

/** 读取候选结果并评分；重试模式保留已有非失败结果，将全部结果重新汇总到 scores 子目录。 */
async function scoreBusinessEvaluation(
  ownerId: string,
  datasetPath: string,
  outputDir: string,
  retryFailed = false,
): Promise<void> {
  const dataset = await readEvaluationDataset(datasetPath);
  const runReport = JSON.parse(await readFile(join(resolve(outputDir), 'run.json'), 'utf8')) as unknown;
  const parsedRunReport = EvaluationRunReportSchema.parse(runReport);
  if (parsedRunReport.owner_id !== ownerId) {
    throw new Error('run.json 的 owner_id 与 --owner-id 不一致。');
  }
  if (parsedRunReport.dataset_version !== dataset.dataset_version) {
    throw new Error('run.json 的 dataset_version 与当前评测集不一致。');
  }
  const scoreDir = join(resolve(outputDir), 'scores');
  const scoringCases: Array<{
    runResult: EvaluationRunCaseResult;
    evaluationCase: EvaluationCase;
    previousResult?: EvaluationCaseResult;
  }> = [];
  // 先读取并校验完整输入，避免发现缺失或错配的旧评分前已发送部分 Judge 请求。
  for (const item of parsedRunReport.cases) {
    const raw = JSON.parse(await readFile(join(resolve(outputDir), item.file_name), 'utf8')) as unknown;
    const runResult = EvaluationRunCaseResultSchema.parse(raw);
    const evaluationCase = dataset.cases.find((candidate) => candidate.case_id === runResult.case_id);
    if (evaluationCase === undefined) {
      throw new Error('run 结果找不到对应评测用例：' + runResult.case_id);
    }
    const previousResult = retryFailed
      ? await readPreviousScore(join(scoreDir, item.file_name), ownerId, runResult)
      : undefined;
    scoringCases.push({ runResult, evaluationCase, previousResult });
  }
  const judge = createJudgeClient();
  if (scoringCases.some(({ previousResult }) => previousResult?.status === 'scored' && previousResult.judge_model !== judge.modelName())) {
    throw new Error('--retry-failed 的已有成功评分与当前 Judge 模型不一致，请恢复原 Judge 模型或执行完整 score。');
  }
  const results: EvaluationCaseResult[] = [];
  for (const { runResult, evaluationCase, previousResult } of scoringCases) {
    if (previousResult !== undefined && previousResult.status !== 'failed') {
      results.push(previousResult);
      console.log('[agent-eval] score case=' + previousResult.case_id + ' status=' + previousResult.status + ' reused=true');
      continue;
    }
    const result = await scoreEvaluationCaseWithJudge({
      ownerId,
      evaluationCase,
      runResult,
      judgeClient: judge,
    });
    results.push(result);
    await writeEvaluationCaseResult(scoreDir, result);
    console.log('[agent-eval] score case=' + result.case_id + ' status=' + result.status);
  }
  const report = buildEvaluationReport({
    runId: parsedRunReport.run_id,
    ownerId,
    datasetVersion: dataset.dataset_version,
    judgeModel: judge.modelName(),
    results,
    startedAt: parsedRunReport.started_at,
  });
  const reportPath = await writeEvaluationReport(scoreDir, report);
  console.log('[agent-eval] 评分报告已写入：' + reportPath);
}

/** 读取重试所需的已有评分，并核对运行身份、候选内容和结构检查，防止复用错配结果。 */
async function readPreviousScore(
  path: string,
  ownerId: string,
  runResult: EvaluationRunCaseResult,
): Promise<EvaluationCaseResult> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('--retry-failed 找不到已有评分：' + runResult.case_id + '。请先执行不带 --retry-failed 的 score。');
    }
    throw error;
  }
  const result = EvaluationCaseResultSchema.parse(JSON.parse(content) as unknown);
  if (
    result.owner_id !== ownerId
    || runResult.owner_id !== ownerId
    || result.run_id !== runResult.run_id
    || result.case_id !== runResult.case_id
    || result.run_type !== runResult.run_type
    || !isDeepStrictEqual(result.business_model, runResult.business_model)
    || !isDeepStrictEqual(result.candidate_output, runResult.candidate_output)
    || !isDeepStrictEqual(result.structure_check, runResult.structure_check)
  ) {
    throw new Error('--retry-failed 的已有评分与 run 候选结果不一致：' + runResult.case_id + '。请执行完整 score。');
  }
  return result;
}

/** 装配现有业务模型网关和按 owner-id 读取默认模型的适配器。 */
function createBusinessDeps(pool: pg.Pool): EvaluationBusinessDeps {
  const auditWriter = new PgModelEgressAuditRepository(pool, readModelEgressAuditRetentionDays());
  const egress = new SafeModelEgressClient(readModelEgressOptions(), auditWriter);
  const gateway = new OpenAiCompatibleModelGateway(egress, readModelGatewayRequestMaxRetries());
  const reactTurns = readAgentReactMaxTurns();
  return {
    modelConnections: new PgOwnerModelConnectionReader(pool),
    decryptor: ModelCredentialDecryptor.fromEnvironment(),
    gateway,
    maxToolCalls: 0,
    reactMaxTurns: {
      assessment_generate: reactTurns.assessmentGenerate,
      posttest_generate: reactTurns.posttestGenerate,
      plan_generate: reactTurns.planGenerate,
      card_content_generate: reactTurns.cardContentGenerate,
    },
  };
}

/** 处理独立进程入口错误并返回非零退出码。 */
async function runMain(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    if (error instanceof AgentEvalCliError) {
      console.error('[agent-eval] ' + error.message);
      console.error(formatAgentEvalCliUsage());
    } else {
      console.error('[agent-eval] 启动失败', error);
    }
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  void runMain();
}
