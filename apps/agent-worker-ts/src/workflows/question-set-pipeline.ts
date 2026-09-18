/**
 * 题集生成管线（等价于 Python 的 workflows/question_set_generation.py）。
 *
 * 职责：执行「首轮生成 → 修复 → 联网兜底」三阶段恢复，逐阶段校验题集合同，失败时只保留脱敏的字段路径。
 * 阶段是否向模型开放 Tavily 由调用方按 Python 的参数决定（repair_with_tavily / final_with_tavily）；
 * 开放工具的阶段走 tool-aware-generator 的工具循环，工具失败会编码成 tool 消息回传模型而不是中断。
 * 本模块不做业务持久化，也不决定错误码归属：全部阶段失败时统一抛出
 * MODEL_STRUCTURED_OUTPUT_INVALID，由调用方决定是否映射成自己的错误码
 * （Python 中 assessment_generate 原样上抛，posttest_generate 映射为 POSTTEST_OUTPUT_INVALID）。
 *
 * 与 Python 的差异：Python 的管线自建 usage 累计；本实现要求调用方传入已记账的 complete，
 * 因此这里只返回正文、恢复阶段与工具调用数，token 记账统一由调用方完成。
 *
 * 导出：
 * - QuestionSetStageName / QUESTION_SET_STAGES：阶段名与执行顺序。
 * - buildRecoveryMessages：按 Python 顺序追加上一轮原文与恢复指令。
 * - validateQuestionSet：解析并校验题集，失败时返回字段路径，绝不记录模型正文。
 * - searchExtractLabel：按工具调用数生成 search_extract 元数据值。
 * - QuestionSetPipelineInput / QuestionSetPipelineOutcome：入参与结果。
 * - runQuestionSetStages：执行三阶段恢复，返回题集、恢复阶段与工具调用数。
 */

import { runToolAwareGeneration } from '../application/services/tool-aware-generator.js';
import {
  ModelGatewayError,
  type ModelCompletionRequest,
  type ModelCompletionResponse,
  type ModelMessage,
  type ModelProviderConnection,
} from '../infrastructure/llm/model-gateway.js';
import {
  TAVILY_SEARCH_TOOL,
  type ToolExecutionResult,
} from '../infrastructure/mcp/tavily-tool-gateway.js';
import type { ModelToolCall } from '../infrastructure/llm/model-gateway.js';
import {
  AssessmentQuestionSetSchema,
  extractJsonText,
  type AssessmentQuestionSet,
} from '../schemas/assessment-question-set.js';

export type QuestionSetStageName = 'initial' | 'repair' | 'tavily_recovery';

/** 与 Python 的阶段顺序完全一致。 */
export const QUESTION_SET_STAGES: readonly QuestionSetStageName[] = [
  'initial',
  'repair',
  'tavily_recovery',
];

/** 工具网关端口：pipeline 只依赖 execute。 */
export interface QuestionSetToolGatewayPort {
  execute(toolCall: ModelToolCall): Promise<ToolExecutionResult>;
}

export interface QuestionSetStageConfig {
  /** repair 阶段是否开放 Tavily（Python 的 repair_with_tavily）。 */
  repairWithTavily: boolean;
  /** tavily_recovery 阶段是否开放 Tavily（Python 的 final_with_tavily）。 */
  finalWithTavily: boolean;
}

export interface QuestionSetPipelineInput {
  /** 已记账的 complete：工作流用它累计真实 token 用量。 */
  complete: (request: ModelCompletionRequest) => Promise<ModelCompletionResponse>;
  toolGateway: QuestionSetToolGatewayPort;
  maxToolCalls: number;
  runId: string;
  connection: ModelProviderConnection;
  baseMessages: readonly ModelMessage[];
  expectedQuestionCount: number;
  repairInstruction: string;
  finalInstruction: string;
  stageConfig: QuestionSetStageConfig;
}

export interface QuestionSetPipelineOutcome {
  questionSet: AssessmentQuestionSet;
  recoveryStage: QuestionSetStageName;
  /** 成功阶段累计的可见工具调用数（与 Python 一致：失败阶段的调用不计入）。 */
  toolCallCount: number;
}

interface StageCompletion {
  content: string;
  toolCallCount: number;
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

/** 按工具调用数生成 search_extract 元数据值（与 Python 的 assessment_generate 一致）。 */
export function searchExtractLabel(toolCallCount: number): string {
  return toolCallCount > 0 ? 'tavily_search_then_extract' : 'not_used';
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

/** 无工具阶段的一次模型请求；返回工具调用或没有正文都算结构错误。 */
async function completeTextOnly(
  complete: QuestionSetPipelineInput['complete'],
  request: ModelCompletionRequest,
): Promise<StageCompletion> {
  const response = await complete(request);
  if ((response.message.toolCalls?.length ?? 0) > 0 || !response.message.content) {
    throw new ModelGatewayError(
      'MODEL_STRUCTURED_OUTPUT_INVALID',
      '模型没有返回可校验的结构化文本结果。',
      false,
      ['response.content_missing'],
    );
  }
  return { content: response.message.content, toolCallCount: 0 };
}

/** 执行三阶段恢复；任何网关错误都继续下一阶段，全部失败时按 Python 规则取舍错误。 */
export async function runQuestionSetStages(
  input: QuestionSetPipelineInput,
): Promise<QuestionSetPipelineOutcome> {
  let previousContent = '';
  let paths: string[] = [];
  let lastError: ModelGatewayError | null = null;
  let toolCallCount = 0;

  for (const stage of QUESTION_SET_STAGES) {
    const withTavily =
      stage === 'initial'
        ? true
        : stage === 'repair'
          ? input.stageConfig.repairWithTavily
          : input.stageConfig.finalWithTavily;

    const messages =
      stage === 'initial'
        ? [...input.baseMessages]
        : buildRecoveryMessages(
            input.baseMessages,
            previousContent,
            stage === 'repair' ? input.repairInstruction : input.finalInstruction,
          );

    const request: ModelCompletionRequest = {
      agentRunId: input.runId,
      connection: input.connection,
      messages,
      responseFormat: 'json_object',
      ...(withTavily
        ? { tools: [TAVILY_SEARCH_TOOL], toolChoice: 'auto' as const }
        : { toolChoice: 'none' as const }),
    };

    try {
      const completion = withTavily
        ? await runToolAwareGeneration({
            complete: input.complete,
            toolGateway: input.toolGateway,
            maxToolCalls: input.maxToolCalls,
            request,
          })
        : await completeTextOnly(input.complete, request);

      previousContent = completion.content;
      toolCallCount += completion.toolCallCount;

      const validated = validateQuestionSet(previousContent, input.expectedQuestionCount);
      if (validated.value !== null) {
        return { questionSet: validated.value, recoveryStage: stage, toolCallCount };
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
