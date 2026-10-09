/**
 * Agent 评测运行器的完整离线测试。
 *
 * 调用顺序：构造固定模型连接、假凭据解密器、固定业务模型和假 Judge → 依次执行四类工作流 →
 * 校验候选结构与 3/2/2/2/1 加权分 → 生成并落盘单条结果与汇总报告 → 读取 JSON 并再次通过运行时契约校验。
 * 本文件不访问数据库、不访问真实模型 Provider，也不把凭据写入测试结果。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildEvaluationReport, writeEvaluationCaseResult, writeEvaluationReport } from '../src/evaluation/report.js';
import { evaluateCaseWithJudge } from '../src/evaluation/runner.js';
import {
  EvaluationCaseResultSchema,
  EvaluationReportSchema,
  type EvaluationCase,
  type EvaluationScores,
} from '../src/evaluation/schema/index.js';
import type { ModelCompletionResponse } from '../src/infrastructure/llm/model-gateway.js';
import type { ModelCredentialDecryptor } from '../src/infrastructure/llm/credential-decryptor.js';
import type { EvaluationBusinessDeps } from '../src/evaluation/runner.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_NODE_ID = '33333333-3333-4333-8333-333333333333';
const CARD_CONTENT_ID = '44444444-4444-4444-8444-444444444444';

/** 构造一个满足内部响应契约的固定默认模型连接。 */
function fixedConnection() {
  return {
    owner_id: OWNER_ID,
    connection_id: CONNECTION_ID,
    base_url: 'https://model.example/v1',
    model_id: 'offline-business-model',
    credential: {
      ciphertext_base64: 'ciphertext',
      iv_base64: 'iv',
      auth_tag_base64: 'tag',
      encryption_key_version: 'v1',
    },
  };
}

/** 构造四类工作流都可复用的固定题目。 */
function fixedQuestion(index: number) {
  return {
    prompt: '第 ' + String(index) + ' 题：TypeScript 中 string 属于哪一类？',
    options: [
      { key: 'A', text: '原始类型' },
      { key: 'B', text: '函数类型' },
      { key: 'C', text: '模块类型' },
    ],
    answer_key: 'A',
    explanation: 'string 是 TypeScript 的原始类型之一。',
    skill_tags: ['类型基础'],
    max_score: 1,
  };
}

/** 构造指定题量的合法题集模型响应。 */
function questionSetResponse(questionCount: number): ModelCompletionResponse {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        schema_version: 'assessment.single_choice.v1',
        questions: Array.from({ length: questionCount }, (_, index) => fixedQuestion(index + 1)),
      }),
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  };
}

/** 构造满足学习路线合同的固定六章模型响应。 */
function planResponse(): ModelCompletionResponse {
  const nodes = Array.from({ length: 6 }, (_, index) => {
    const ordinal = index + 1;
    const nodeKey = 'typescript_node_' + String(ordinal);
    return {
      node_key: nodeKey,
      ordinal,
      title: 'TypeScript 第 ' + String(ordinal) + ' 章',
      node_brief: '掌握第 ' + String(ordinal) + ' 章的基础知识。',
      learning_objective: '能够解释并应用第 ' + String(ordinal) + ' 章的概念。',
      rationale: '为后续章节建立必要基础。',
      difficulty: Math.min(5, ordinal),
      estimated_minutes: 60,
      prerequisite_node_keys: ordinal === 1 ? [] : ['typescript_node_' + String(ordinal - 1)],
      completion_criteria: ['能完成本章练习。'],
    };
  });
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        schema_version: 'learning_plan.v1',
        title: 'TypeScript 学习路线',
        summary: '按依赖顺序学习 TypeScript。',
        nodes,
      }),
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  };
}

/** 构造满足 card_content.v2 合同的固定节点内容模型响应。 */
function cardContentResponse(): ModelCompletionResponse {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        schema_version: 'card_content.v2',
        foundation: 'TypeScript 使用类型系统帮助 JavaScript 代码表达数据约束。',
        worked_example: {
          explanation: '先定义类型，再由入口函数使用该类型。',
          files: [{
            path: 'src/index.ts',
            language: 'ts',
            role: 'entry',
            content: 'type User = { name: string };\nfunction greet(user: User): string { return user.name; }',
          }],
          entry_file: 'src/index.ts',
          call_sequence: [{ step: 1, file: 'src/index.ts', function: 'greet', note: '读取用户名称并返回问候内容。' }],
          expected_output: 'src/index.ts › greet：返回用户名称。',
        },
        pitfalls_debug: [{
          title: '把类型注解当成运行时校验',
          cause: '类型信息在编译阶段使用。',
          fix: '运行时仍需显式校验外部输入。',
        }],
        source_refs: [],
        teaching_memory: {
          key_concepts: ['类型注解'],
          common_mistakes: ['忽略运行时输入校验'],
          assessment_targets: ['能够写出简单类型注解'],
        },
      }),
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  };
}

/** 构造固定评测数据中的四类工作流输入。 */
function evaluationCases(): EvaluationCase[] {
  const common = {
    dataset_version: 'offline-v1',
    learner_profile: { current_level: 'beginner' },
    reference_facts: ['TypeScript 是 JavaScript 的超集。'],
    required_knowledge_points: ['类型注解'],
    acceptable_answer_points: ['能解释类型注解的用途。'],
    scoring_rubric: {
      correctness: '事实正确。',
      completeness: '覆盖要求的知识点。',
      relevance: '围绕当前目标。',
      readability: '表达清楚易读。',
      teaching_adaptation: '适合初学者。',
    },
    tags: ['offline'],
  };
  return [
    {
      ...common,
      case_id: 'offline-assessment',
      run_type: 'assessment_generate',
      input_snapshot: { topic: 'TypeScript', question_count: 10, difficulty: 'normal', kind: 'diagnostic' },
    },
    {
      ...common,
      case_id: 'offline-plan',
      run_type: 'plan_generate',
      input_snapshot: {
        goal: { id: 'goal-1', topic: 'TypeScript', title: 'TypeScript 入门', description: '学习类型系统。', desired_outcome: '能够写出类型安全代码。' },
        learner_profile: { profile_version: 1, current_level: 'beginner', weekly_minutes: 120, background_summary: null },
        diagnostic_assessment: { assessment_id: 'assessment-1', score_percent: 40, mastery_summary: {} },
      },
    },
    {
      ...common,
      case_id: 'offline-card-content',
      run_type: 'card_content_generate',
      input_snapshot: {
        agent_role: 'node_tutor',
        logical_session_key: 'offline-session',
        goal: { topic: 'TypeScript' },
        learner_profile: { current_level: 'beginner' },
        learning_plan: { title: 'TypeScript 入门' },
        plan_node: { id: PLAN_NODE_ID, title: '类型注解', summary: '学习类型注解。' },
      },
    },
    {
      ...common,
      case_id: 'offline-posttest',
      run_type: 'posttest_generate',
      input_snapshot: {
        topic: 'TypeScript',
        question_count: 5,
        difficulty: 'normal',
        kind: 'post_test',
        plan_node_id: PLAN_NODE_ID,
        source_card_content_id: CARD_CONTENT_ID,
        card_content_context: {
          plan_node_id: PLAN_NODE_ID,
          card_content_id: CARD_CONTENT_ID,
          foundation: 'TypeScript 使用类型系统帮助 JavaScript 代码表达数据约束。',
          worked_example: {},
          pitfalls_debug: [{ title: '类型注解', cause: '类型信息用于编译期。', fix: '运行时校验外部输入。' }],
          teaching_memory: { key_concepts: ['类型注解'], assessment_targets: ['能够写出类型注解'] },
        },
      },
    },
  ];
}

/** 按调用顺序返回四类工作流所需的固定模型响应。 */
function createFixedBusinessGateway() {
  let callIndex = 0;
  const responses = [questionSetResponse(10), planResponse(), cardContentResponse(), questionSetResponse(5)];
  return {
    complete: async (): Promise<ModelCompletionResponse> => {
      const response = responses[callIndex];
      callIndex += 1;
      if (response === undefined) {
        throw new Error('固定假模型收到超出预期的调用。');
      }
      return response;
    },
  };
}

/** 构造固定五维 1–5 分的假 Judge。 */
function createFixedJudge(): EvaluationBusinessDeps['gateway'] & {
  modelName(): string;
  scoreCandidate(input: { evaluationCase: EvaluationCase; candidateOutput: unknown }): Promise<EvaluationScores>;
} {
  const scores: EvaluationScores = {
    correctness: { score: 5, reason: '事实准确。', evidence: ['固定离线证据'] },
    completeness: { score: 4, reason: '覆盖完整。', evidence: ['固定离线证据'] },
    relevance: { score: 4, reason: '目标相关。', evidence: ['固定离线证据'] },
    readability: { score: 3, reason: '表达清晰。', evidence: ['固定离线证据'] },
    teaching_adaptation: { score: 2, reason: '适配初学者。', evidence: ['固定离线证据'] },
  };
  return {
    complete: async () => questionSetResponse(5),
    modelName: () => 'offline-judge',
    scoreCandidate: async () => scores,
  };
}

/** 执行四类工作流并验证结果落盘与汇总报告。 */
describe('evaluation runner offline flow', () => {
  it('使用固定假模型和假 Judge 完成四类工作流评测', async () => {
    const businessGateway = createFixedBusinessGateway();
    const fakeDecryptor = { decrypt: () => 'offline-api-key' } as unknown as ModelCredentialDecryptor;
    const deps: EvaluationBusinessDeps = {
      modelConnections: { getDefaultModelConnection: async () => fixedConnection() },
      decryptor: fakeDecryptor,
      gateway: businessGateway,
      maxToolCalls: 0,
      reactMaxTurns: {
        assessment_generate: 1,
        plan_generate: 1,
        card_content_generate: 1,
        posttest_generate: 1,
      },
    };
    const judge = createFixedJudge();
    const results = [];
    for (const evaluationCase of evaluationCases()) {
      results.push(await evaluateCaseWithJudge({
        ownerId: OWNER_ID,
        evaluationCase,
        judgeClient: judge,
        runId: 'offline-run-' + evaluationCase.case_id,
      }, deps));
    }

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === 'scored')).toBe(true);
    expect(results.every((result) => result.structure_check.passed)).toBe(true);
    expect(results.every((result) => result.weighted_score === 3.9)).toBe(true);
    expect(results.every((result) => result.percentage_score === 78)).toBe(true);

    const report = buildEvaluationReport({
      runId: 'offline-report-run',
      ownerId: OWNER_ID,
      datasetVersion: 'offline-v1',
      judgeModel: judge.modelName(),
      results,
      startedAt: '2026-10-09T00:00:00.000Z',
      finishedAt: '2026-10-09T00:01:00.000Z',
    });
    expect(report.total_cases).toBe(4);
    expect(report.scored_cases).toBe(4);
    expect(report.invalid_cases).toBe(0);
    expect(report.failed_cases).toBe(0);
    expect(report.dimension_averages).toEqual({
      correctness: 5,
      completeness: 4,
      relevance: 4,
      readability: 3,
      teaching_adaptation: 2,
    });
    expect(report.weighted_average).toBe(3.9);
    expect(report.percentage_average).toBe(78);

    const outputDir = await mkdtemp(join(tmpdir(), 'learncraft-agent-eval-'));
    try {
      const casePaths = await Promise.all(results.map((result) => writeEvaluationCaseResult(outputDir, result)));
      const reportPath = await writeEvaluationReport(outputDir, report);
      expect(casePaths).toHaveLength(4);
      expect(reportPath).toBe(join(outputDir, 'report.json'));
      const storedReport = EvaluationReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')) as unknown);
      expect(storedReport).toEqual(report);
      for (const casePath of casePaths) {
        const storedCase = EvaluationCaseResultSchema.parse(JSON.parse(await readFile(casePath, 'utf8')) as unknown);
        expect(storedCase.status).toBe('scored');
        expect(JSON.stringify(storedCase)).not.toContain('offline-api-key');
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
