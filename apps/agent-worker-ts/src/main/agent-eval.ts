/**
 * 独立 Agent 评测进程入口。
 *
 * 调用顺序：main 解析 CLI → 读取并校验评测集 → 装配业务模型网关和 owner-id 默认模型读取器 →
 * 逐条调用现有四类工作流 → 调用独立 Judge → 将单次结果和汇总报告写入 output 目录。
 * 业务模型沿用现有受控出网网关；Judge 只使用 AGENT_EVAL_JUDGE_* 环境变量。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { readAgentReactMaxTurns, readModelEgressAuditRetentionDays, readModelEgressOptions, readModelGatewayRequestMaxRetries } from '../bootstrap/config.js';
import { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import { OpenAiCompatibleModelGateway } from '../infrastructure/llm/model-gateway.js';
import { PgModelEgressAuditRepository } from '../infrastructure/database/model-egress-audit-repository.js';
import { SafeModelEgressClient } from '../infrastructure/llm/safe-egress-client.js';
import {
  AgentEvalCliError,
  formatAgentEvalCliUsage,
  parseAgentEvalCliArgs,
} from '../evaluation/cli.js';
import { createJudgeClient } from '../evaluation/judge.js';
import {
  evaluateCaseWithJudge,
  PgOwnerModelConnectionReader,
  type EvaluationBusinessDeps,
} from '../evaluation/runner.js';
import {
  buildEvaluationReport,
  writeEvaluationCaseResult,
  writeEvaluationReport,
} from '../evaluation/report.js';
import {
  EvaluationDatasetSchema,
  type EvaluationCaseResult,
} from '../evaluation/schema/index.js';

/** 判断当前模块是否由 Node 作为独立进程入口直接执行。 */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/** 解析参数并执行完整离线评测。 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseAgentEvalCliArgs(argv);
  if ('help' in parsed) {
    console.log(formatAgentEvalCliUsage());
    return;
  }
  const dataset = await readEvaluationDataset(parsed.datasetPath);
  const judge = createJudgeClient();
  const pool = new pg.Pool({ connectionString: requireDatabaseUrl(), max: 8 });
  try {
    const businessDeps = createBusinessDeps(pool);
    const startedAt = new Date().toISOString();
    const reportRunId = 'agent-eval-' + Date.now().toString(36);
    const results: EvaluationCaseResult[] = [];
    for (const evaluationCase of dataset.cases) {
      const result = await evaluateCaseWithJudge(
        { ownerId: parsed.ownerId, evaluationCase, judgeClient: judge },
        businessDeps,
      );
      results.push(result);
      await writeEvaluationCaseResult(parsed.outputDir, result);
      console.log('[agent-eval] case=' + result.case_id + ' status=' + result.status);
    }
    const report = buildEvaluationReport({
      runId: reportRunId,
      ownerId: parsed.ownerId,
      datasetVersion: dataset.dataset_version,
      judgeModel: judge.modelName(),
      results,
      startedAt,
    });
    const reportPath = await writeEvaluationReport(parsed.outputDir, report);
    console.log('[agent-eval] 报告已写入：' + reportPath);
  } finally {
    await pool.end();
  }
}

/** 必须配置数据库连接，以便读取 owner-id 默认模型并复用业务出网审计。 */
function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error('缺少必需的环境变量：DATABASE_URL');
  }
  return value;
}

/** 读取 JSON 或 JSONL 评测集并通过统一契约校验。 */
async function readEvaluationDataset(path: string) {
  const content = await readFile(resolve(path), 'utf8');
  let raw: unknown;
  if (path.toLowerCase().endsWith('.jsonl')) {
    const cases = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const first = cases[0];
    if (!isRecord(first) || typeof first.dataset_version !== 'string') {
      throw new Error('JSONL 评测集首行必须包含 dataset_version。');
    }
    raw = { schema_version: 'agent_eval.dataset.v1', dataset_version: first.dataset_version, cases };
  } else {
    raw = JSON.parse(content) as unknown;
  }
  const parsed = EvaluationDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('评测集不符合 agent_eval.dataset.v1 契约。');
  }
  return parsed.data;
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

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
