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
 * 阶段控制流（首轮 → 修复、恢复消息顺序、错误取舍）已抽到 question-set-pipeline.ts，
 * 与 posttest_generate 共用同一份实现。
 *
 * 联网工具（Tavily 远程 MCP）已接入：首轮开放工具，修复阶段不开放，最终 tavily_recovery 阶段
 * 重新开放；真实 tool_call_count 与 search_extract 写入 generation_metadata。
 *
 * 导出：
 * - AssessmentGenerationInputSchema / AssessmentGenerationInput
 * - AssessmentGenerationDeps：工作流依赖（内部接口客户端、凭据解密器、模型网关）。
 * - AssessmentGenerationResult：outputSummary（与 Python 同键）与 usage（供调用方写 token 用量）。
 * - runAssessmentGenerate：执行一次前测生成。
 */

import { z } from 'zod';

import type { ToolGatewayPort } from '../application/services/tool-aware-generator.js';

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
  runQuestionSetStages,
  searchExtractLabel,
  type QuestionSetToolGatewayPort,
} from './question-set-pipeline.js';

const REPAIR_INSTRUCTION =
  '请修复题集 JSON，只返回合法 schema_version 和 questions；每道题必须严格包含 prompt、options、answer_key、explanation、skill_tags、max_score，options 必须是 {key,text} 对象数组，answer_key 必须引用已有选项。';

const FINAL_INSTRUCTION =
  '请执行题集最终恢复。可以使用 Tavily 获取可靠资料，但最终只返回 assessment.single_choice.v1 合法 JSON；'
  + '题目数量必须严格匹配，每个 options 必须是 {key,text} 对象数组。';

const SYSTEM_PROMPT = [
  '你是 LearnCraft 程序员学习评估题目设计师。题目必须是单选题，最终只输出一个严格 JSON 对象，不要输出对象外的 Markdown 或解释文字。',
  '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。',
  '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；语言标签、代码、命令和标识符保持英文。',
  'JSON 字符串中的结构换行必须使用单层转义 \n，绝不能使用双重转义 \\n；代码中原本需要表示换行字符时保留其自身的转义语义。',
  '当主题涉及近期版本、快速变化的 API、兼容性、官方规范，或你对事实没有足够把握时，使用 tavily_search 获取可靠资料。',
  '对于稳定且你有足够把握的基础知识，可直接生成题目；不要为调用工具而调用工具。',
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
  /** 联网工具网关（Tavily）；未配置 Key 时返回受控错误而不是抛异常。 */
  toolGateway: QuestionSetToolGatewayPort;
  /** 单次运行可见的工具调用上限。 */
  maxToolCalls: number;
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

  // 阶段顺序、恢复消息、工具开放范围与错误取舍都在共享管线里，与 posttest_generate 使用同一份实现。
  // 与 Python 一致：首轮开放 Tavily，修复阶段不开放，最终 tavily_recovery 阶段开放。
  const usage = { inputTokens: 0, outputTokens: 0 };
  const complete = async (request: ModelCompletionRequest): Promise<ModelCompletionResponse> => {
    const response = await deps.gateway.complete(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  };

  const outcome = await runQuestionSetStages({
    complete,
    toolGateway: deps.toolGateway,
    maxToolCalls: deps.maxToolCalls,
    runId: input.runId,
    connection: modelConnection,
    baseMessages,
    expectedQuestionCount: generationInput.question_count,
    repairInstruction: REPAIR_INSTRUCTION,
    finalInstruction: FINAL_INSTRUCTION,
    stageConfig: { repairWithTavily: false, finalWithTavily: true },
  });
  const questionSet = outcome.questionSet;
  const recoveryStage = outcome.recoveryStage;

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
      tool_call_count: outcome.toolCallCount,
      search_extract: searchExtractLabel(outcome.toolCallCount),
      recovery_stage: recoveryStage,
    },
  });

  return {
    outputSummary: {
      assessment_id: persisted.assessment_id,
      status: persisted.status,
      question_count: persisted.question_count,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: recoveryStage,
      model_id: connection.model_id,
    },
    usage,
  };
}

/**
 * 把前测工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export type AssessmentGenerationWorkflowDeps = Omit<AssessmentGenerationDeps, 'toolGateway'> & {
  /** 按运行所属账户构造工具网关：每日配额按账户计数，且 Key 缺失时返回受控错误。 */
  createToolGateway: (ownerId: string) => ToolGatewayPort;
};

export function createAssessmentGenerateWorkflow(deps: AssessmentGenerationWorkflowDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runAssessmentGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        { ...deps, toolGateway: deps.createToolGateway(executionState.ownerId) },
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
