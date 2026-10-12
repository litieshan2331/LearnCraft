/**
 * 学习助手 Agent 共用的模型调用、轨迹定位、消息标识及子模型循环。
 * 调用顺序：各 Agent 传入自己的提示词和校验器 → callModel 调用共享网关 → runChildModel 保存工具/修复状态。
 * 本文件不定义任何角色提示词或角色专属输出合同。
 */
import { createHash } from 'node:crypto';
import { ModelGatewayError, type ModelMessage } from '../../../infrastructure/llm/model-gateway.js';
import type { TraceWriter } from '../../../application/services/trace-writer.js';
import type { LearningAssistantDependencies } from '../ports.js';
import { validateEvidenceReferences, type Actor, type Attribution, type SocraticResponse } from '../schemas/index.js';
import { incrementReactTurns, type AssistantState, type ConversationMessage } from '../state.js';
import { buildValidationFeedback } from '../prompts/validation-feedback.js';
import { toolsForActor } from '../tools/index.js';

type AgentPromptBuilder = (state: AssistantState, skillSummaries: readonly { id: string; title: string; summary: string }[]) => string;

/** 返回当前角色的 ReAct 上限；上限由服务端装配，模型和用户不能修改。 */
export function reactLimitFor(deps: LearningAssistantDependencies, actor: Actor): number {
  return deps.reactLimits[actor];
}

/** 生成稳定的 Agent ReAct 上限错误，供图节点和测试识别。 */
export function reactLimitExceeded(actor: Actor, limit: number): ModelGatewayError {
  return new ModelGatewayError(
    'LEARNING_ASSISTANT_REACT_LIMIT_EXCEEDED',
    '学习助手 Agent ' + actor + ' 已达到本次运行的 ReAct 轮数上限 ' + String(limit) + '。',
    false,
  );
}

/** 稳定 UUID 用于轨迹父子关联、消息幂等及恢复后的结果复用。 */
export function stableId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** 给请求级轨迹注入嵌套位置，覆盖网关旧工作流观测端口。 */
function scopedTrace(deps: LearningAssistantDependencies, actor: Actor, spanId: string, parentSpanId: string | null): TraceWriter {
  return { /** 写入当前模型请求的嵌套轨迹。 */ async append(event) { await deps.trace.append({ ...event, spanId, parentSpanId, agentName: actor }); } };
}

/** 给当前轮消息分配可重试的固定 ID。 */
export function conversationMessage(state: AssistantState, suffix: string, message: ModelMessage): ConversationMessage {
  return { ...message, id: stableId(state.input.run_id + ':' + suffix), turnNo: state.input.message.turn_no };
}

/** 主子 Agent 共用模型请求和轨迹记录，连接密钥只停留在依赖对象中。 */
export async function callModel(deps: LearningAssistantDependencies, state: AssistantState, actor: Actor, messages: ModelMessage[], repairing: boolean, buildPrompt: AgentPromptBuilder) {
  const reactLimit = reactLimitFor(deps, actor);
  if (state.reactTurns[actor] >= reactLimit) throw reactLimitExceeded(actor, reactLimit);
  const step = state.modelStep + 1;
  const parentSpan = actor === 'main' ? stableId(state.input.run_id) : state.child?.spanId ?? null;
  const span = stableId(state.input.run_id + ':model:' + step);
  const tools = repairing ? undefined : toolsForActor(actor);
  const response = await deps.model.complete({
    agentRunId: state.input.run_id, turnNo: state.input.message.turn_no,
    connection: deps.connection,
    messages: [{ role: 'system', content: buildPrompt(state, deps.skills.listSkills().filter(/** 只暴露对话助手可用的 Skill。 */ (skill) => skill.workflows.includes('learning_assistant')))
      + '\n\n#运行控制\n当前是 ' + actor + ' 的第 ' + String(state.reactTurns[actor] + 1) + ' 轮，本次最多 ' + String(reactLimit) + ' 轮。请在达到上限前输出最终结构化 JSON；需要时仍可调用已提供工具，不要等待额外轮次。' }, ...messages],
    tools, responseFormat: 'json_object',
    /** 每次实际尝试在数据库原子记录，重试和备用也进入统一观测计数。 */
    beforeModelAttempt: async () => { await deps.reserveModelAttempt(state.input); },
    traceWriter: scopedTrace(deps, actor, span, parentSpan),
  });
  if (response.message.role !== 'assistant') throw new Error('模型返回了非法消息角色');
  const ids = response.message.toolCalls?.map(/** 提取工具调用唯一标识。 */ (call) => call.id) ?? [];
  if (ids.some(/** 检查空调用标识。 */ (id) => id.trim() === '') || new Set(ids).size !== ids.length) throw new Error('模型工具调用 ID 缺失或重复');
  if (repairing && ids.length > 0) throw new Error('输出修复期间禁止调用工具');
  return { response, step };
}

/** 执行共用子模型循环；角色由独立 Agent 文件指定，输出使用其专属校验器。 */
export async function runChildModel(
  deps: LearningAssistantDependencies,
  state: AssistantState,
  actor: Exclude<Actor, 'main'>,
  buildPrompt: AgentPromptBuilder,
  parseOutput: (raw: unknown, state: AssistantState) => Attribution | SocraticResponse,
): Promise<Partial<AssistantState>> {
  const child = state.child;
  if (child === null || child.actor !== actor) throw new Error('缺少或不匹配的子 Agent 状态');
  const { response, step } = await callModel(deps, state, actor, child.messages, child.repairUsed, buildPrompt);
  const messages = [...child.messages, response.message];
  const pending = [...(response.message.toolCalls ?? [])];
  if (pending.length > 0) return { modelStep: step, reactTurns: incrementReactTurns(state.reactTurns, actor), child: { ...child, messages, pending, index: 0, toolBatchStep: step } };
  try {
    const raw: unknown = JSON.parse(response.message.content ?? '');
    const output = parseOutput(raw, state);
    const recentTurns = new Set([...new Set(state.messages.map(/** 提取证据所属轮次。 */ (message) => message.turnNo))].sort(/** 轮次升序。 */ (a, b) => a - b).slice(-20));
    validateEvidenceReferences(output, state.context.evidence.filter(/** 仅校验近期及业务证据。 */ (item) => item.turn_no === null || recentTurns.has(item.turn_no)));
    return { modelStep: step, reactTurns: incrementReactTurns(state.reactTurns, actor), child: { ...child, messages, pending: [], result: output } };
  } catch (error) {
    if (child.repairUsed) throw new Error('LEARNING_ASSISTANT_OUTPUT_INVALID：子 Agent 一次修复后仍非法', { cause: error });
    return { modelStep: step, reactTurns: incrementReactTurns(state.reactTurns, actor), child: { ...child, messages: [...messages, { role: 'user', content: buildValidationFeedback(error) }], pending: [], repairUsed: true } };
  }
}

/** 保留旧端口测试可复用的预算错误构造器；学习助手运行时不再调用它。 */
export function modelBudgetExceeded(): ModelGatewayError {
  return new ModelGatewayError('LEARNING_ASSISTANT_MODEL_BUDGET_EXCEEDED', '模型请求预算已用完。', false);
}
