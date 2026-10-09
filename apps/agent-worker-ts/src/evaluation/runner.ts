/**
 * 离线 Agent 评测运行器的业务工作流编排。
 *
 * 调用顺序：runEvaluationCase 先按 owner-id 读取默认模型连接并创建评测用内部端口，
 * 再调用四个现有工作流函数捕获候选输出，随后执行结构合同校验；evaluateCaseWithJudge
 * 在结构通过后调用独立 Judge 并生成单条结果。PgOwnerModelConnectionReader 只读取用户默认
 * 模型连接，不修改数据库 Schema，也不把凭据写入评测结果。
 *
 * 导出：
 * - PgOwnerModelConnectionReader / EvaluationModelConnectionPort：按 owner-id 读取默认模型。
 * - EvaluationBusinessDeps / EvaluationCaseExecution：业务工作流执行依赖和候选结果。
 * - runEvaluationCase / evaluateCaseWithJudge：执行一条用例及 Judge 评分。
 * - checkCandidateStructure / calculateWeightedScore：结构检查和 3/2/2/2/1 加权计算。
 */

import { randomUUID } from 'node:crypto';

import type { AgentWorkflowResult } from '../application/commands/execute-agent-run.js';
import type { ToolGatewayPort } from '../application/services/tool-aware-generator.js';
import type { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
} from '../infrastructure/llm/model-gateway.js';
import {
  AssessmentQuestionSetSchema,
} from '../schemas/assessment-question-set.js';
import {
  DefaultModelConnectionEnvelopeSchema,
  CardContentContextEnvelopeSchema,
  type CardContentContextEnvelope,
  type DefaultModelConnectionEnvelope,
  type PersistedAssessmentEnvelope,
  type PersistedCardContentEnvelope,
  type PersistedLearningPlanEnvelope,
} from '../schemas/core-internal.js';
import { runAssessmentGenerate } from '../workflows/assessment-generate/index.js';
import { CardContentDocumentSchema, runCardContentGenerate } from '../workflows/card-content-generate/index.js';
import { LearningPlanDocumentSchema, runPlanGenerate } from '../workflows/plan-generate/index.js';
import { runPosttestGenerate } from '../workflows/posttest-generate/index.js';
import {
  EvaluationCaseResultSchema,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationStructureCheck,
  type EvaluationRunType,
} from './schema/index.js';
import type { EvaluationScores } from './schema/index.js';
import type { JudgeClientPort } from './judge.js';

/** 按用户读取默认模型连接的最小端口。 */
export interface EvaluationModelConnectionPort {
  getDefaultModelConnection(ownerId: string): Promise<DefaultModelConnectionEnvelope>;
}

/** 支持测试注入的数据库查询端口。 */
export interface EvaluationQueryPort {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 从 public.user_model_connections 读取账户当前 active 默认模型连接。 */
export class PgOwnerModelConnectionReader implements EvaluationModelConnectionPort {
  /** 注入数据库查询端口，便于独立进程和离线测试复用同一读取逻辑。 */
  constructor(private readonly database: EvaluationQueryPort) {}

  /** 查询 owner-id 对应的默认连接，并用现有响应契约校验字段。 */
  async getDefaultModelConnection(ownerId: string): Promise<DefaultModelConnectionEnvelope> {
    const result = await this.database.query(
      [
        'SELECT owner_id, id AS connection_id, base_url, default_model_id AS model_id,',
        'encrypted_api_key AS ciphertext_base64, api_key_iv AS iv_base64,',
        'api_key_auth_tag AS auth_tag_base64, encryption_key_version',
        'FROM public.user_model_connections',
        'WHERE owner_id = $1 AND status = \'active\' AND is_default = true',
        'LIMIT 1',
      ].join(' '),
      [ownerId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('当前账户没有可用的默认模型连接。');
    }
    const parsed = DefaultModelConnectionEnvelopeSchema.safeParse({
      owner_id: row.owner_id,
      connection_id: row.connection_id,
      base_url: row.base_url,
      model_id: row.model_id,
      credential: {
        ciphertext_base64: row.ciphertext_base64,
        iv_base64: row.iv_base64,
        auth_tag_base64: row.auth_tag_base64,
        encryption_key_version: row.encryption_key_version,
      },
    });
    if (!parsed.success || parsed.data.owner_id !== ownerId) {
      throw new Error('默认模型连接不符合评测运行器契约。');
    }
    return parsed.data;
  }
}

/** 业务工作流调用所需依赖；模型网关仍复用现有业务网关。 */
export interface EvaluationBusinessDeps {
  modelConnections: EvaluationModelConnectionPort;
  decryptor: ModelCredentialDecryptor;
  gateway: {
    complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
  };
  toolGateway?: ToolGatewayPort;
  maxToolCalls?: number;
  reactMaxTurns?: Partial<Record<EvaluationRunType, number>>;
}

/** 一条用例执行后的候选输出和业务模型信息。 */
export interface EvaluationCaseExecution {
  runId: string;
  caseId: string;
  runType: EvaluationRunType;
  businessModel: { connection_id: string; model_id: string };
  candidateOutput: unknown;
  structureCheck: EvaluationStructureCheck;
  outputSummary: Record<string, unknown> | null;
}

/** 评测内部端口：把工作流的持久化结果捕获到内存，避免新增或修改业务数据。 */
interface EvaluationInternalPort {
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  getCardContentContext(agentRunId: string): Promise<CardContentContextEnvelope>;
  persistAssessment(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope>;
  persistLearningPlan(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedLearningPlanEnvelope>;
  persistCardContent(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedCardContentEnvelope>;
}

/** 执行一条业务工作流并捕获其最终候选输出。 */
export async function runEvaluationCase(input: {
  ownerId: string;
  evaluationCase: EvaluationCase;
  runId?: string;
}, deps: EvaluationBusinessDeps): Promise<EvaluationCaseExecution> {
  const runId = input.runId ?? randomUUID();
  const envelope = await deps.modelConnections.getDefaultModelConnection(input.ownerId);
  if (envelope.owner_id !== input.ownerId) {
    throw new Error('默认模型连接的 owner_id 与 --owner-id 不一致。');
  }
  const capture: { candidate: unknown; summary: Record<string, unknown> | null } = {
    candidate: null,
    summary: null,
  };
  const internal = createEvaluationInternalPort(envelope, input.evaluationCase, capture);
  const toolGateway = deps.toolGateway ?? createDisabledToolGateway();
  const maxToolCalls = deps.maxToolCalls ?? 0;
  const maxTurns = deps.reactMaxTurns?.[input.evaluationCase.run_type] ?? 1;
  const common = {
    internalClient: internal,
    decryptor: deps.decryptor,
    gateway: deps.gateway,
    toolGateway,
    maxToolCalls,
    reactMaxTurns: maxTurns,
  };

  let result: AgentWorkflowResult;
  const workflowInputSnapshot = input.evaluationCase.run_type === 'posttest_generate'
    ? withoutCardContentContext(input.evaluationCase.input_snapshot)
    : input.evaluationCase.input_snapshot;
  if (input.evaluationCase.run_type === 'assessment_generate') {
    result = await runAssessmentGenerate(
      { runId, inputSummaryJson: workflowInputSnapshot },
      common,
    );
  } else if (input.evaluationCase.run_type === 'plan_generate') {
    result = await runPlanGenerate(
      { runId, inputSummaryJson: workflowInputSnapshot },
      common,
    );
  } else if (input.evaluationCase.run_type === 'card_content_generate') {
    result = await runCardContentGenerate(
      { runId, inputSummaryJson: workflowInputSnapshot },
      common,
    );
  } else {
    result = await runPosttestGenerate(
      { runId, inputSummaryJson: workflowInputSnapshot },
      common,
    );
  }
  capture.summary = result.outputSummary;
  const structureCheck = checkCandidateStructure(input.evaluationCase.run_type, capture.candidate);
  return {
    runId,
    caseId: input.evaluationCase.case_id,
    runType: input.evaluationCase.run_type,
    businessModel: { connection_id: envelope.connection_id, model_id: envelope.model_id },
    candidateOutput: capture.candidate,
    structureCheck,
    outputSummary: capture.summary,
  };
}

/** 执行业务工作流、结构校验和 Judge 评分，生成可直接落盘的单条结果。 */
export async function evaluateCaseWithJudge(input: {
  ownerId: string;
  evaluationCase: EvaluationCase;
  judgeClient: JudgeClientPort;
  runId?: string;
  startedAt?: string;
}, deps: EvaluationBusinessDeps): Promise<EvaluationCaseResult> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  let execution: EvaluationCaseExecution | null = null;
  try {
    execution = await runEvaluationCase(input, deps);
    const finishedAt = new Date().toISOString();
    if (!execution.structureCheck.passed) {
      return EvaluationCaseResultSchema.parse({
        schema_version: 'agent_eval.case_result.v1',
        run_id: execution.runId,
        case_id: execution.caseId,
        owner_id: input.ownerId,
        run_type: execution.runType,
        business_model: execution.businessModel,
        judge_model: getJudgeModel(input.judgeClient),
        candidate_output: execution.candidateOutput,
        structure_check: execution.structureCheck,
        scores: null,
        weighted_score: null,
        percentage_score: null,
        status: 'invalid',
        error: '候选输出未通过结构合同校验。',
        started_at: startedAt,
        finished_at: finishedAt,
      });
    }
    const scores = await input.judgeClient.scoreCandidate({
      evaluationCase: input.evaluationCase,
      candidateOutput: execution.candidateOutput,
    });
    const weightedScore = calculateWeightedScore(scores);
    return EvaluationCaseResultSchema.parse({
      schema_version: 'agent_eval.case_result.v1',
      run_id: execution.runId,
      case_id: execution.caseId,
      owner_id: input.ownerId,
      run_type: execution.runType,
      business_model: execution.businessModel,
      judge_model: getJudgeModel(input.judgeClient),
      candidate_output: execution.candidateOutput,
      structure_check: execution.structureCheck,
      scores,
      weighted_score: weightedScore,
      percentage_score: (weightedScore / 5) * 100,
      status: 'scored',
      error: null,
      started_at: startedAt,
      finished_at: finishedAt,
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return EvaluationCaseResultSchema.parse({
      schema_version: 'agent_eval.case_result.v1',
      run_id: execution?.runId ?? input.runId ?? randomUUID(),
      case_id: input.evaluationCase.case_id,
      owner_id: input.ownerId,
      run_type: input.evaluationCase.run_type,
      business_model: execution?.businessModel ?? { connection_id: 'unknown', model_id: 'unknown' },
      judge_model: getJudgeModel(input.judgeClient),
      candidate_output: execution?.candidateOutput ?? null,
      structure_check: execution?.structureCheck ?? { passed: false, errors: ['业务工作流执行失败。'] },
      scores: null,
      weighted_score: null,
      percentage_score: null,
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      started_at: startedAt,
      finished_at: finishedAt,
    });
  }
}

/** 对已经落盘的候选结果执行 Judge 评分，不重新调用业务模型。 */
export async function scoreEvaluationCaseWithJudge(input: {
  ownerId: string;
  evaluationCase: EvaluationCase;
  runResult: {
    run_id: string;
    case_id: string;
    run_type: EvaluationRunType;
    business_model: { connection_id: string; model_id: string };
    candidate_output: unknown;
    structure_check: EvaluationStructureCheck;
    started_at: string;
    finished_at: string;
    status: 'completed' | 'invalid' | 'failed';
    error: string | null;
  };
  judgeClient: JudgeClientPort;
}): Promise<EvaluationCaseResult> {
  const runResult = input.runResult;
  const base = {
    schema_version: 'agent_eval.case_result.v1' as const,
    run_id: runResult.run_id,
    case_id: runResult.case_id,
    owner_id: input.ownerId,
    run_type: runResult.run_type,
    business_model: runResult.business_model,
    judge_model: getJudgeModel(input.judgeClient),
    candidate_output: runResult.candidate_output,
    structure_check: runResult.structure_check,
    started_at: runResult.started_at,
    finished_at: new Date().toISOString(),
  };
  if (runResult.status !== 'completed' || !runResult.structure_check.passed) {
    return EvaluationCaseResultSchema.parse({
      ...base,
      scores: null,
      weighted_score: null,
      percentage_score: null,
      status: runResult.status === 'invalid' ? 'invalid' : 'failed',
      error: runResult.error ?? '业务模型运行结果未达到可评分状态。',
    });
  }
  try {
    const scores = await input.judgeClient.scoreCandidate({
      evaluationCase: input.evaluationCase,
      candidateOutput: runResult.candidate_output,
    });
    const weightedScore = calculateWeightedScore(scores);
    return EvaluationCaseResultSchema.parse({
      ...base,
      scores,
      weighted_score: weightedScore,
      percentage_score: (weightedScore / 5) * 100,
      status: 'scored',
      error: null,
    });
  } catch (error) {
    return EvaluationCaseResultSchema.parse({
      ...base,
      scores: null,
      weighted_score: null,
      percentage_score: null,
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
    });
  }
}

/** 按 3/2/2/2/1 权重计算 1–5 加权平均分。 */
export function calculateWeightedScore(scores: EvaluationScores): number {
  const weighted = (
    scores.correctness.score * 3
    + scores.completeness.score * 2
    + scores.relevance.score * 2
    + scores.readability.score * 2
    + scores.teaching_adaptation.score
  ) / 10;
  return Number(weighted.toFixed(4));
}

/** 按四类工作流的现有输出合同检查候选结果。 */
export function checkCandidateStructure(
  runType: EvaluationRunType,
  candidate: unknown,
): EvaluationStructureCheck {
  if (!isRecord(candidate)) {
    return { passed: false, errors: ['候选输出不是 JSON 对象。'] };
  }
  if (runType === 'assessment_generate' || runType === 'posttest_generate') {
    const parsed = AssessmentQuestionSetSchema.safeParse({
      schema_version: candidate.schema_version,
      questions: candidate.questions,
    });
    return parsed.success ? { passed: true, errors: [] } : { passed: false, errors: ['题集输出不符合题集合同。'] };
  }
  if (runType === 'plan_generate') {
    const parsed = LearningPlanDocumentSchema.safeParse({
      schema_version: candidate.schema_version,
      title: candidate.title,
      summary: candidate.summary,
      nodes: candidate.nodes,
    });
    return parsed.success ? { passed: true, errors: [] } : { passed: false, errors: ['学习路线输出不符合路线合同。'] };
  }
  const parsed = CardContentDocumentSchema.safeParse({
    schema_version: candidate.schema_version,
    foundation: candidate.foundation,
    worked_example: candidate.worked_example,
    pitfalls_debug: candidate.pitfalls_debug,
    source_refs: candidate.source_refs,
    teaching_memory: candidate.teaching_memory,
  });
  return parsed.success ? { passed: true, errors: [] } : { passed: false, errors: ['节点内容输出不符合内容合同。'] };
}

/** 创建一个禁用联网工具的评测端口；maxToolCalls 默认 0，因此正常不会触发执行。 */
function createDisabledToolGateway(): ToolGatewayPort {
  return {
    execute: async () => ({
      ok: false,
      code: 'EVALUATION_TOOL_DISABLED',
      message: '离线评测运行器未启用联网工具。',
      data: {},
    }),
  };
}

/** 创建捕获候选输出的内部接口适配器。 */
function createEvaluationInternalPort(
  envelope: DefaultModelConnectionEnvelope,
  evaluationCase: EvaluationCase,
  capture: { candidate: unknown; summary: Record<string, unknown> | null },
): EvaluationInternalPort {
  const context = evaluationCase.run_type === 'posttest_generate'
    ? readCardContentContext(evaluationCase.input_snapshot)
    : null;
  return {
    getDefaultModelConnection: async () => envelope,
    getCardContentContext: async () => {
      if (context === null) {
        throw new Error('当前评测工作流不需要 card_content_context。');
      }
      return context;
    },
    persistAssessment: async (_agentRunId, payload) => {
      capture.candidate = payload;
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      return { assessment_id: randomUUID(), status: 'ready', question_count: questions.length };
    },
    persistLearningPlan: async (_agentRunId, payload) => {
      capture.candidate = payload;
      const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
      return { learning_plan_id: randomUUID(), node_count: nodes.length };
    },
    persistCardContent: async (_agentRunId, payload) => {
      capture.candidate = payload;
      return { card_content_id: randomUUID(), status: 'ready' };
    },
  };
}

/** 从评测输入中读取 posttest 所需节点内容上下文。 */
function readCardContentContext(snapshot: Record<string, unknown>): CardContentContextEnvelope {
  const value = snapshot.card_content_context ?? snapshot.cardContentContext;
  const parsed = CardContentContextEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('posttest_generate 评测用例缺少 card_content_context。');
  }
  return parsed.data;
}

/** 去掉仅供评测运行器读取的节点内容上下文，避免违反 posttest 输入合同的 strict 校验。 */
function withoutCardContentContext(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...snapshot };
  delete copy.card_content_context;
  delete copy.cardContentContext;
  return copy;
}

/** 从 Judge 客户端读取模型名称；避免暴露 API Key。 */
function getJudgeModel(client: JudgeClientPort): string {
  return client.modelName();
}

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
