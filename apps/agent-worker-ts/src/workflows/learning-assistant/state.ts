/**
 * 学习助手可恢复图状态；不保存连接密钥或运行时对象。
 * 调用顺序：prepare 初始化本轮 → 主模型/串行工具 → 子模型/串行工具 → 主回复 → 幂等持久化。
 */
import { Annotation } from '@langchain/langgraph';
import type { ModelMessage, ModelToolCall } from '../../infrastructure/llm/model-gateway.js';
import { IntentSchema, StageSchema, type Evidence, type Intent, type RunInput, type Stage } from './schemas/index.js';

export interface ConversationMessage extends ModelMessage { id: string; turnNo: number }
export interface ReactTurnCounts {
  main: number;
  error_attribution: number;
  socratic_tutor: number;
}
export interface TrustedContext {
  facts: Record<string, unknown>; evidence: Evidence[];
}
export interface DelegationState {
  toolCallId: string;
  target: 'error_attribution' | 'socratic_tutor';
  task: string;
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  resultText: string | null;
  errorCode: string | null;
}

/** Checkpoint 的可序列化版本；未知版本必须显式阻止恢复。 */
export const LEARNING_ASSISTANT_STATE_VERSION = 4;

/** 校验 Checkpoint 版本；缺失版本也拒绝恢复，避免把旧结构静默当成新 State。 */
export function assertSupportedStateVersion(value: unknown): asserts value is number {
  if (value !== LEARNING_ASSISTANT_STATE_VERSION) throw new Error('学习助手 Checkpoint 版本不受支持');
}

/** 校验由服务端维护的窄控制状态，禁止从自然语言或越界 Checkpoint 继续执行。 */
export function assertControlState(state: Pick<AssistantState, 'intent' | 'stage' | 'hintLevel' | 'stalledTurns' | 'pendingQuestion' | 'verificationTarget' | 'delegation'>): void {
  if (state.intent !== null && !IntentSchema.safeParse(state.intent).success) throw new Error('学习助手意图状态不受支持');
  if (!StageSchema.safeParse(state.stage).success) throw new Error('学习助手阶段状态不受支持');
  if (!Number.isInteger(state.hintLevel) || state.hintLevel < 0 || state.hintLevel > 3) throw new Error('学习助手提示级别越界');
  if (!Number.isInteger(state.stalledTurns) || state.stalledTurns < 0) throw new Error('学习助手停滞轮数非法');
  if (state.pendingQuestion !== null && state.pendingQuestion.trim().length > 2_000) throw new Error('学习助手待回答问题过长');
  if (state.verificationTarget !== null && state.verificationTarget.trim().length > 3_000) throw new Error('学习助手验证目标过长');
  if (state.delegation !== null) {
    if (typeof state.delegation.toolCallId !== 'string' || state.delegation.toolCallId.trim().length === 0) throw new Error('学习助手委派缺少 tool_call_id');
    if (state.delegation.target !== 'error_attribution' && state.delegation.target !== 'socratic_tutor') throw new Error('学习助手委派目标不受支持');
    if (!['requested', 'running', 'succeeded', 'failed'].includes(state.delegation.status)) throw new Error('学习助手委派状态不受支持');
    if (typeof state.delegation.task !== 'string' || state.delegation.task.length > 4_000) throw new Error('学习助手委派任务不受支持');
  }
}

/** 显式序列化可恢复 State；连接密钥和运行时对象不属于 State，不能出现在结果中。 */
export function serializeAssistantState(state: AssistantState): string {
  assertSupportedStateVersion(state.stateVersion);
  assertControlState(state);
  return JSON.stringify(state);
}

/** 按轮裁剪完整工具链，当前用户轮计入 20 轮；业务历史不受影响。 */
export function recentModelMessages(messages: readonly ConversationMessage[], currentTurn: number): ModelMessage[] {
  const turns = [...new Set(messages.filter((item) => item.turnNo <= currentTurn).map((item) => item.turnNo))].sort((a, b) => a - b).slice(-20);
  const allowed = new Set(turns);
  return messages.filter((item) => allowed.has(item.turnNo)).map(({ id: _id, turnNo: _turn, ...message }) => message);
}

/** 确定性消息 ID 保证重试合并时不会重复追加。 */
export function mergeMessages(left: readonly ConversationMessage[], right: readonly ConversationMessage[]): ConversationMessage[] {
  const result = new Map(left.map((item) => [item.id, item]));
  for (const item of right) result.set(item.id, item);
  return [...result.values()];
}

/** 为一个 Agent 递增本次运行的 ReAct 轮数；计数写入 Checkpoint。 */
export function incrementReactTurns(counts: ReactTurnCounts, actor: keyof ReactTurnCounts): ReactTurnCounts {
  return { ...counts, [actor]: counts[actor] + 1 };
}

export const LearningAssistantState = Annotation.Root({
  stateVersion: Annotation<number>({ default: () => LEARNING_ASSISTANT_STATE_VERSION, reducer: (_left, right) => right }),
  input: Annotation<RunInput>(),
  activeRunId: Annotation<string>({ default: () => '', reducer: (_left, right) => right }),
  messages: Annotation<ConversationMessage[]>({ default: () => [], reducer: (_left, right) => right }),
  pendingMainToolCalls: Annotation<ModelToolCall[]>({ default: () => [], reducer: (_left, right) => right }),
  delegation: Annotation<DelegationState | null>({ default: () => null, reducer: (_left, right) => right }),
  context: Annotation<TrustedContext>({ default: () => ({ facts: {}, evidence: [] }), reducer: (_left, right) => right }),
  questionId: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  intent: Annotation<Intent | null>({ default: () => null, reducer: (_left, right) => right }),
  stage: Annotation<Stage>({ default: () => 'new', reducer: (_left, right) => right }),
  hintLevel: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  stalledTurns: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  pendingQuestion: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  verificationTarget: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  responseText: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  diagnosisText: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  tutorText: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  modelStep: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  reactTurns: Annotation<ReactTurnCounts>({ default: () => ({ main: 0, error_attribution: 0, socratic_tutor: 0 }), reducer: (_left, right) => right }),
});
export type AssistantState = typeof LearningAssistantState.State;
