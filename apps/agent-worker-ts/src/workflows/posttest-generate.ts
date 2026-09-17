/**
 * posttest_generate 节点后测生成工作流（等价于 Python 的 workflows/posttest_generate.py）。
 *
 * 职责：读取 AgentRun 输入快照 → 经 Web 内部接口取固定节点内容上下文与账户默认模型连接 →
 * 解密凭据 → 基于「节点内容 + teaching_memory」生成题集 → 结构校验与受控修复 →
 * 经内部接口幂等持久化 → 返回运行摘要与用量。
 *
 * 与 Python 逐项对齐的行为：
 * - 内部接口调用顺序：先取节点内容上下文，再取默认模型连接；
 * - 输入契约：extra 禁止、kind 固定 post_test、题量 5-10、difficulty 默认 normal，
 *   plan_node_id 与 source_card_content_id 必填；
 * - 提示词：system 与 user 文案一致，固定节点内容按契约字段顺序序列化后嵌入 user；
 * - 阶段控制流复用 question-set-pipeline.ts（Python 的 question_set_generation.py）；
 * - 输出摘要为 Python 的 5 个键（无 status），回写载荷含 plan_id=null 与 4 键元数据；
 * - 结构类失败映射为 POSTTEST_OUTPUT_INVALID，并在消息里附带最多 8 条校验路径。
 *
 * **已确认的行为差异（与 assessment_generate 相同，不是实现遗漏）：**
 * token 用量写真实值，由调用方写入 agent_runs 的 token 列。
 *
 * **与 Python 现状的已知差异（阶段 5 补齐）：**
 * 1. 未接入 Tavily 远程 MCP，工具调用被完全移除：tool_call_count 恒为 0，
 *    共享管线缺少 tavily_recovery 兜底；
 * 2. 因此修复指令删去了「本阶段可以根据需要调用 tavily_search」一句。
 *
 * 导出：
 * - PosttestGenerationInputSchema / PosttestGenerationInput
 * - PosttestInternalPort / PosttestModelGatewayPort：工作流依赖的最小端口。
 * - PosttestGenerationDeps / PosttestGenerationResult。
 * - runPosttestGenerate：执行一次节点后测生成。
 * - createPosttestGenerateWorkflow：适配为注册表可用的 AgentWorkflow。
 */

import { z } from 'zod';

import type { AgentWorkflow } from '../application/commands/execute-agent-run.js';
import type { ModelCredentialDecryptor } from '../infrastructure/llm/credential-decryptor.js';
import {
  ModelGatewayError,
  type ModelProviderConnection,
} from '../infrastructure/llm/model-gateway.js';
import type {
  CardContentContextEnvelope,
  DefaultModelConnectionEnvelope,
  PersistedAssessmentEnvelope,
} from '../schemas/core-internal.js';
import {
  runQuestionSetStages,
  type QuestionSetModelGatewayPort,
} from './question-set-pipeline.js';

const REPAIR_INSTRUCTION = [
  '后测输出校验失败。请基于原节点内容重新输出严格 JSON。',
  '不要 Markdown、解释文字或额外字段；顶层只能是 schema_version 和 questions。',
  'schema_version 必须精确为 assessment.single_choice.v1，题目数量必须严格匹配请求。',
  '每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  'options 必须是 2 至 6 个 {key,text} 对象，key 只能是 A-F，answer_key 必须引用已有选项。',
].join('');

const SYSTEM_PROMPT = [
  '你是 LearnCraft 的 Node Tutor 后测设计师。最终只输出严格 JSON。',
  '只能基于给定的节点内容和 teaching_memory 出题，不得引入外部新知识。',
  '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。',
  '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；JSON 字符串中的结构换行使用单层转义 \n，不能使用双重转义 \\n。',
  'JSON 顶层只能包含 schema_version 和 questions；schema_version 固定为 assessment.single_choice.v1。',
  '每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  'options 必须是 2 至 6 个对象；每个 options 对象只能包含 key 和 text，key 必须是 A、B、C、D、E 或 F，text 必须是非空字符串。',
  'answer_key 必须是 options 中实际存在的 key；题目数量必须严格匹配请求。',
].join('');

export const PosttestGenerationInputSchema = z
  .object({
    topic: z.string().min(1).max(300),
    question_count: z.number().int().min(5).max(10),
    difficulty: z.enum(['normal', 'hard']).default('normal'),
    kind: z.literal('post_test'),
    plan_node_id: z.string().min(1).max(64),
    source_card_content_id: z.string().min(1).max(64),
  })
  .strict();

export type PosttestGenerationInput = z.infer<typeof PosttestGenerationInputSchema>;

/** 内部接口端口：工作流只依赖这三个方法。 */
export interface PosttestInternalPort {
  getCardContentContext(agentRunId: string): Promise<CardContentContextEnvelope>;
  getDefaultModelConnection(agentRunId: string): Promise<DefaultModelConnectionEnvelope>;
  persistAssessment(agentRunId: string, payload: Record<string, unknown>): Promise<PersistedAssessmentEnvelope>;
}

/** 模型网关端口：与共享管线使用同一个最小端口。 */
export type PosttestModelGatewayPort = QuestionSetModelGatewayPort;

export interface PosttestGenerationDeps {
  internalClient: PosttestInternalPort;
  decryptor: ModelCredentialDecryptor;
  gateway: PosttestModelGatewayPort;
}

export interface PosttestGenerationResult {
  /** 与 Python 完全一致的 5 个摘要键，直接写入 output_summary_json。 */
  outputSummary: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * 按契约字段顺序序列化固定节点内容。
 * Python 用 orjson.dumps 输出紧凑 JSON，键序取自响应模型的字段定义；
 * 这里显式重排，保证嵌入提示词的文本与 Python 一致。
 */
function serializeCardContentContext(context: CardContentContextEnvelope): string {
  return JSON.stringify({
    plan_node_id: context.plan_node_id,
    card_content_id: context.card_content_id,
    foundation: context.foundation,
    worked_example: context.worked_example,
    pitfalls_debug: context.pitfalls_debug,
    teaching_memory: context.teaching_memory,
  });
}

function buildUserPrompt(input: PosttestGenerationInput, contentJson: string): string {
  return [
    '后测主题：' + input.topic,
    '题目数量：' + String(input.question_count),
    '难度：' + input.difficulty,
    '固定节点内容(JSON)：' + contentJson,
  ].join('\n');
}

/** 执行一次节点后测生成；失败时抛出带稳定错误码的 ModelGatewayError 或 CoreInternalClientError。 */
export async function runPosttestGenerate(
  input: {
    runId: string;
    inputSummaryJson: Record<string, unknown>;
  },
  deps: PosttestGenerationDeps,
): Promise<PosttestGenerationResult> {
  const parsedInput = PosttestGenerationInputSchema.safeParse(input.inputSummaryJson);
  if (!parsedInput.success) {
    throw new ModelGatewayError('POSTTEST_INPUT_INVALID', '节点后测输入不符合契约。', false);
  }
  const generationInput = parsedInput.data;

  const context = await deps.internalClient.getCardContentContext(input.runId);
  const connectionEnvelope = await deps.internalClient.getDefaultModelConnection(input.runId);
  const apiKey = deps.decryptor.decrypt(connectionEnvelope.owner_id, connectionEnvelope.credential);
  const connection: ModelProviderConnection = {
    ownerId: connectionEnvelope.owner_id,
    connectionId: connectionEnvelope.connection_id,
    baseUrl: connectionEnvelope.base_url,
    modelId: connectionEnvelope.model_id,
    apiKey,
  };

  const baseMessages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: buildUserPrompt(generationInput, serializeCardContentContext(context)),
    },
  ];

  let outcome;
  try {
    outcome = await runQuestionSetStages({
      gateway: deps.gateway,
      runId: input.runId,
      connection,
      baseMessages,
      expectedQuestionCount: generationInput.question_count,
      repairInstruction: REPAIR_INSTRUCTION,
    });
  } catch (error) {
    if (error instanceof ModelGatewayError && error.code === 'MODEL_STRUCTURED_OUTPUT_INVALID') {
      const pathSummary = error.validationPaths.slice(0, 8).join(', ');
      const suffix = pathSummary.length > 0 ? ' 校验路径: ' + pathSummary : '';
      throw new ModelGatewayError(
        'POSTTEST_OUTPUT_INVALID',
        '节点后测结果不符合题集合同。' + suffix,
        false,
      );
    }
    throw error;
  }

  const questionSet = outcome.questionSet;
  // 共享管线已按题量校验，这里是与 Python 对齐的兜底断言。
  if (questionSet.questions.length !== generationInput.question_count) {
    throw new ModelGatewayError(
      'POSTTEST_QUESTION_COUNT_INVALID',
      '节点后测题目数量与请求不一致。',
      false,
    );
  }

  const persisted = await deps.internalClient.persistAssessment(input.runId, {
    kind: generationInput.kind,
    question_count: generationInput.question_count,
    difficulty: generationInput.difficulty,
    plan_id: null,
    plan_node_id: generationInput.plan_node_id,
    source_card_content_id: generationInput.source_card_content_id,
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
      model_id: connection.modelId,
      source_card_content_id: generationInput.source_card_content_id,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: outcome.recoveryStage,
    },
  });

  return {
    outputSummary: {
      assessment_id: persisted.assessment_id,
      question_count: persisted.question_count,
      tool_call_count: outcome.toolCallCount,
      recovery_stage: outcome.recoveryStage,
      model_id: connection.modelId,
    },
    usage: outcome.usage,
  };
}

/**
 * 把节点后测工作流适配为注册表可用的 AgentWorkflow：只负责把 AgentRun 执行状态转换为工作流入参，
 * 并把结果原样交给命令层（命令层负责把 usage 写入 token 列）。
 */
export function createPosttestGenerateWorkflow(deps: PosttestGenerationDeps): AgentWorkflow {
  return {
    run: async (executionState) => {
      const result = await runPosttestGenerate(
        { runId: executionState.runId, inputSummaryJson: executionState.inputSummaryJson },
        deps,
      );
      return { outputSummary: result.outputSummary, usage: result.usage };
    },
  };
}
