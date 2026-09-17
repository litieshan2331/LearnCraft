/**
 * assessment_generate 前测题集生成工作流（显式异步实现，后续由 LangGraph.js 图替换）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取账户默认模型连接 → 解密凭据 →
 * 调用模型生成题集 → 结构校验与受控修复 → 经内部接口幂等持久化 → 返回运行摘要与用量。
 *
 * 与 Python（assessment_generate.py + question_set_generation.py）逐项对齐的行为：
 * - 输入契约：extra 忽略、title/description 等可空、difficulty 默认 normal、diagnostic 题量必须 10-20；
 * - 提示词：system 与 user 文案一致（仅移除联网工具相关两句，见下），修复指令与 Python 完全相同；
 * - 修复请求：在原有消息后依次追加“上一轮原文的 assistant 消息”与“修复指令的 system 消息”；
 * - 控制流：任何 ModelGatewayError 都继续进入下一阶段；全部失败时，
 *   若最后一个错误不是结构校验错误则原样上抛，否则汇总前 8 条校验路径抛 MODEL_STRUCTURED_OUTPUT_INVALID；
 * - 模型无正文或返回工具调用时，以 response.content_missing 路径判为结构错误；
 * - 回写载荷与输出摘要字段与 Python 一致（含 plan_id=null 与 6 个摘要键）。
 *
 * **已确认的行为差异（2026-09-17 用户确认，不是实现遗漏）：**
 * token 用量写真实值。Python 的 mark_succeeded 恒定写 input_tokens=0/output_tokens=0；
 * 本实现把跨阶段累计的 usage 通过返回值交给调用方，调用方必须写入 agent_runs 的 token 列，
 * 使用量与成本可观测。因此 outputSummary 保持 Python 的 6 键，usage 单独返回。
 *
 * **与 Python 现状的已知差异（阶段 5 补齐）：**
 * 1. 未接入 Tavily 远程 MCP，首轮与修复阶段都不提供工具，因此 tool_call_count 恒为 0、
 *    search_extract 恒为 not_used，且三阶段恢复只实现 initial 与 repair，缺少 tavily_recovery；
 * 2. system 提示词用“不提供联网工具”替换了 Python 的两句 Tavily 指令。
 * 上述差异不影响前两阶段的等价性。
 *
 * 导出：
 * - AssessmentGenerationInputSchema / AssessmentGenerationInput
 * - AssessmentGenerationDeps：工作流依赖（内部接口客户端、凭据解密器、模型网关）。
 * - AssessmentGenerationResult：outputSummary（与 Python 同键）与 usage（供调用方写 token 用量）。
 * - runAssessmentGenerate：执行一次前测生成。
 */

import { z } from 'zod';

import type { AgentWorkflow } from '../application/commands/execute-agent-run.js';
import type { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
} from '../infrastructure/llm/model-gateway.js';
import type { DefaultModelConnectionEnvelope, PersistedAssessmentEnvelope } from '../schemas/core-internal.js';
import {
  AssessmentQuestionSetSchema,
  extractJsonText,
  type AssessmentQuestionSet,
} from '../schemas/assessment-question-set.js';

const REPAIR_INSTRUCTION =
  '请修复题集 JSON，只返回合法 schema_version 和 questions；每道题必须严格包含 prompt、options、answer_key、explanation、skill_tags、max_score，options 必须是 {key,text} 对象数组，answer_key 必须引用已有选项。';

const SYSTEM_PROMPT = [
  '你是 LearnCraft 程序员学习评估题目设计师。题目必须是单选题，最终只输出一个严格 JSON 对象，不要输出对象外的 Markdown 或解释文字。',
  '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。',
  '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；语言标签、代码、命令和标识符保持英文。',
  'JSON 字符串中的结构换行必须使用单层转义，绝不能使用双重转义；代码中原本需要表示换行字符时保留其自身的转义语义。',
  '本次不提供任何联网检索工具，请仅依据你已掌握的知识生成题目，不要编造时效性强的版本信息。',
  'JSON 顶层只能包含 schema_version 和 questions：schema_version 固定为 assessment.single_choice.v1；questions 必须是题目数组。',
  '每道题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  'options 必须是 2 至 6 个对象，每个对象只能包含 key 和 text；answer_key 必须是 options 中存在的 A 至 F 键；max_score 必须为正数。',
].join('');

export const AssessmentGenerationInputSchema = z
  .object({
    topic: z.string().min(1).max(300),
    title: z.string().max(300).nullish(),
    description: z.string().max(2_000).nullish(),
    desired_outcome: z.string().max(2_000).nullish(),
    background: z.string().max(4_000).nullish(),
    overall_experience: z.string().max(1_000).nullish(),
    question_count: z.number().int().min(5).max(20),
    difficulty: z.enum(['normal', 'hard']).default('normal'),
    kind: z.literal('diagnostic'),
  })
  .loose()
  .superRefine((value, context) => {
    // 与 Python 的 model_validator 一致：diagnostic 题量必须为 10-20。
    if (value.question_count < 10 || value.question_count > 20) {
      context.addIssue({
        code: 'custom',
        path: ['question_count'],
        message: 'diagnostic 题量必须为 10-20',
      });
    }
  });

export type AssessmentGenerationInput = z.infer<typeof AssessmentGenerationInputSchema>;

/** 内部接口端口：工作流只依赖这两个方法。 */
export interface AssessmentInternalPort {
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistAssessment(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope>;
}

/** 模型网关端口：工作流只依赖 complete。 */
export interface AssessmentModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface AssessmentGenerationDeps {
  internalClient: AssessmentInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: AssessmentModelGatewayPort;
}

export interface AssessmentGenerationResult {
  /** 与 Python 完全一致的 6 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

function buildUserPrompt(input: AssessmentGenerationInput): string {
  return [
    '主题：' + input.topic,
    '标题：' + (input.title ?? input.topic),
    '描述：' + (input.description ?? ''),
    '目标：' + (input.desired_outcome ?? ''),
    '整体编程经验：' + (input.overall_experience ?? ''),
    '测试类型：' + input.kind,
    '难度：' + input.difficulty,
    '请生成恰好 ' + String(input.question_count) + ' 道题，每题包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  ].join('\n');
}

/** 构造修复请求：先追加上一轮原文的 assistant 消息，再追加修复指令（与 Python 顺序一致）。 */
function buildRecoveryMessages(
  baseMessages: readonly ModelMessage[],
  previousContent: string,
  instruction: string,
): ModelMessage[] {
  return [
    ...baseMessages,
    { role: 'assistant', content: previousContent },
    { role: 'system', content: instruction },
  ];
}

/** 解析并校验题集；失败时返回字段路径，且绝不记录模型正文。 */
function validateQuestionSet(
  content: string,
  expectedQuestionCount: number,
): { value: AssessmentQuestionSet | null; paths: string[] } {
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

/** 执行一次前测生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runAssessmentGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: AssessmentGenerationDeps,
): Promise<AssessmentGenerationResult> {
  const parsedInput = AssessmentGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('ASSESSMENT_INPUT_INVALID', '题集生成输入不符合契约。', false);
  }
  const generationInput = parsedInput.data;

  const connection = await deps.internalClient.getDefaultModelConnection(input.runId);
  const apiKey = deps.decryptor.decrypt(connection.owner_id, connection.credential);
  const modelConnection = {
    ownerId: connection.owner_id,
    connectionId: connection.connection_id,
    baseUrl: connection.base_url,
    modelId: connection.model_id,
    apiKey,
  };

  const baseMessages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(generationInput) },
  ];

  // 阶段顺序与 Python 一致；tavily_recovery 因未接入 MCP 而暂缺。
  const stages = ['initial', 'repair'] as const;
  let questionSet: AssessmentQuestionSet | null = null;
  let recoveryStage: (typeof stages)[number] = 'initial';
  let previousContent = '';
  let paths: string[] = [];
  let lastError: ModelGatewayError | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const stage of stages) {
    const messages =
      stage === 'initial'
        ? baseMessages
        : buildRecoveryMessages(baseMessages, previousContent, REPAIR_INSTRUCTION);
    try {
      const response = await deps.gateway.complete({
        agentRunId: input.runId,
        connection: modelConnection,
        messages,
        responseFormat: 'json_object',
      });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;

      // 与 Python 的 _complete 一致：返回工具调用或没有正文都算结构错误。
      if ((response.message.toolCalls?.length ?? 0) > 0 || !response.message.content) {
        throw new ModelGatewayError(
          'MODEL_STRUCTURED_OUTPUT_INVALID',
          '模型没有返回可校验的结构化文本结果。',
          false,
          ['response.content_missing'],
        );
      }

      previousContent = response.message.content;
      const validated = validateQuestionSet(previousContent, generationInput.question_count);
      if (validated.value !== null) {
        questionSet = validated.value;
        recoveryStage = stage;
        break;
      }
      paths = validated.paths;
    } catch (error) {
      if (error instanceof ModelGatewayError) {
        lastError = error;
        paths = error.validationPaths.length > 0 ? [...error.validationPaths] : paths;
        continue;
      }
      throw error;
    }
  }

  if (questionSet === null) {
    if (lastError !== null && lastError.code !== 'MODEL_STRUCTURED_OUTPUT_INVALID') {
      throw lastError;
    }
    const finalPaths = paths.length > 0 ? paths : ['response.json'];
    throw new ModelGatewayError(
      'MODEL_STRUCTURED_OUTPUT_INVALID',
      '题集结果经过恢复后仍不符合合同。校验路径: ' + finalPaths.slice(0, 8).join(', '),
      false,
      finalPaths.slice(0, 8),
    );
  }

  const persisted = await deps.internalClient.persistAssessment(input.runId, {
    kind: generationInput.kind,
    question_count: generationInput.question_count,
    difficulty: generationInput.difficulty,
    plan_id: null,
    schema_version: questionSet.schema_version,
    questions: questionSet.questions.map((question) => ({
      prompt: question.prompt,
      options: question.options.map((option) => ({ key: option.key, text: option.text })),
      answer_key: question.answer_key,
      explanation: question.explanation,
      skill_tags: question.skill_tags,
      max_score: question.max_score,
    })),
    generation_metadata: {
      topic: generationInput.topic,
      model_id: connection.model_id,
      tool_call_count: 0,
      search_extract: 'not_used',
      recovery_stage: recoveryStage,
    },
  });

  return {
    outputSummary: {
      assessment_id: persisted.assessment_id,
      status: persisted.status,
      question_count: persisted.question_count,
      tool_call_count: 0,
      recovery_stage: recoveryStage,
      model_id: connection.model_id,
    },
    usage: { inputTokens, outputTokens },
  };
}

/**
 * 把前测工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export function createAssessmentGenerateWorkflow(deps: AssessmentGenerationDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runAssessmentGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        deps,
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
