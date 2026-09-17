/**
 * 题集生成管线（等价于 Python 的 workflows/question_set_generation.py）。
 *
 * 职责：执行「首轮生成 → 修复」两阶段恢复，逐阶段校验题集合同，失败时只保留脱敏的字段路径。
 * 本模块不做业务持久化，也不决定错误码归属：全部阶段失败时统一抛出
 * MODEL_STRUCTURED_OUTPUT_INVALID，由调用方决定是否映射成自己的错误码
 * （Python 中 assessment_generate 原样上抛，posttest_generate 映射为 POSTTEST_OUTPUT_INVALID）。
 *
 * **与 Python 的已知差异（Tavily 远程 MCP 尚未接入，属阶段 5 待补齐项）：**
 * - 阶段集合只有 initial 与 repair，缺少 tavily_recovery 兜底，因此不接受
 *   final_instruction 与 repair_with_tavily / final_with_tavily 参数；
 * - 所有阶段都不提供工具，tool_call_count 恒为 0；
 * - 调用方传入的修复指令必须已删去联网检索相关句子。
 *
 * 导出：
 * - QuestionSetStageName：阶段名（initial / repair）。
 * - QUESTION_SET_STAGES：阶段执行顺序。
 * - buildRecoveryMessages：按 Python 顺序追加上一轮原文与恢复指令。
 * - validateQuestionSet：解析并校验题集，失败时返回字段路径，绝不记录模型正文。
 * - QuestionSetModelGatewayPort：管线依赖的最小模型网关端口。
 * - QuestionSetPipelineInput / QuestionSetPipelineOutcome：入参与结果。
 * - runQuestionSetStages：执行两阶段恢复，返回题集、恢复阶段、工具调用数与累计用量。
 */

import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
  type ModelProviderConnection,
} from '../infrastructure/llm/model-gateway.js';
import {
  AssessmentQuestionSetSchema,
  extractJsonText,
  type AssessmentQuestionSet,
} from '../schemas/assessment-question-set.js';

export type QuestionSetStageName = 'initial' | 'repair';

/** Python 的阶段顺序是 initial → repair → tavily_recovery，本实现缺最后一段。 */
export const QUESTION_SET_STAGES: readonly QuestionSetStageName[] = ['initial', 'repair'];

export interface QuestionSetModelGatewayPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export interface QuestionSetPipelineInput {
  gateway: QuestionSetModelGatewayPort;
  runId: string;
  connection: ModelProviderConnection;
  baseMessages: readonly ModelMessage[];
  expectedQuestionCount: number;
  repairInstruction: string;
}

export interface QuestionSetPipelineOutcome {
  questionSet: AssessmentQuestionSet;
  recoveryStage: QuestionSetStageName;
  /** 当前恒为 0；接入 Tavily 后由工具循环累加。 */
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** 构造恢复请求：先追加上一轮原文的 assistant 消息，再追加恢复指令（与 Python 顺序一致）。 */
export function buildRecoveryMessages(
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
export function validateQuestionSet(
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

/** 执行两阶段恢复；任何网关错误都继续下一阶段，全部失败时按 Python 规则取舍错误。 */
export async function runQuestionSetStages(
  input: QuestionSetPipelineInput,
): Promise<QuestionSetPipelineOutcome> {
  let previousContent = '';
  let paths: string[] = [];
  let lastError: ModelGatewayError | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const stage of QUESTION_SET_STAGES) {
    const messages =
      stage === 'initial'
        ? [...input.baseMessages]
        : buildRecoveryMessages(input.baseMessages, previousContent, input.repairInstruction);
    try {
      const response = await input.gateway.complete({
        agentRunId: input.runId,
        connection: input.connection,
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
      const validated = validateQuestionSet(previousContent, input.expectedQuestionCount);
      if (validated.value !== null) {
        return {
          questionSet: validated.value,
          recoveryStage: stage,
          toolCallCount: 0,
          usage: { inputTokens, outputTokens },
        };
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
