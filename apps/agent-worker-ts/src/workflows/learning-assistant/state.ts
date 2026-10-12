/**
 * 学习助手可恢复图状态；不保存连接密钥或运行时对象。
 * 调用顺序：prepare 初始化本轮 → 主模型/串行工具 → 子模型/串行工具 → 主回复 → 幂等持久化。
 */
import { Annotation } from '@langchain/langgraph';
import type { ModelMessage, ModelToolCall } from '../../infrastructure/llm/model-gateway.js';
import type { Actor, Attribution, Evidence, MainResponse, RunInput, SocraticResponse } from './schemas/index.js';

export interface ConversationMessage extends ModelMessage { id: string; turnNo: number }
export interface ChildState {
  actor: Exclude<Actor, 'main'>; spanId: string; messages: ModelMessage[];
  pending: ModelToolCall[]; index: number; repairUsed: boolean;
  toolBatchStep: number;
  result: Attribution | SocraticResponse | null;
}
export interface ReactTurnCounts {
  main: number;
  error_attribution: number;
  socratic_tutor: number;
}
export interface TrustedContext {
  facts: Record<string, unknown>; evidence: Evidence[];
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
  input: Annotation<RunInput>(),
  activeRunId: Annotation<string>({ default: () => '', reducer: (_left, right) => right }),
  messages: Annotation<ConversationMessage[]>({ default: () => [], reducer: (_left, right) => right }),
  context: Annotation<TrustedContext>({ default: () => ({ facts: {}, evidence: [] }), reducer: (_left, right) => right }),
  questionId: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  intent: Annotation<MainResponse['intent'] | null>({ default: () => null, reducer: (_left, right) => right }),
  stage: Annotation<MainResponse['stage']>({ default: () => 'new', reducer: (_left, right) => right }),
  diagnosis: Annotation<Attribution | null>({ default: () => null, reducer: (_left, right) => right }),
  tutor: Annotation<SocraticResponse | null>({ default: () => null, reducer: (_left, right) => right }),
  hintLevel: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  stalledTurns: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  pendingQuestion: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  verificationTarget: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  pending: Annotation<ModelToolCall[]>({ default: () => [], reducer: (_left, right) => right }),
  toolIndex: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  toolBatchStep: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  child: Annotation<ChildState | null>({ default: () => null, reducer: (_left, right) => right }),
  mainRepairUsed: Annotation<boolean>({ default: () => false, reducer: (_left, right) => right }),
  repairMessages: Annotation<ModelMessage[]>({ default: () => [], reducer: (_left, right) => right }),
  response: Annotation<MainResponse | null>({ default: () => null, reducer: (_left, right) => right }),
  modelStep: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
  reactTurns: Annotation<ReactTurnCounts>({ default: () => ({ main: 0, error_attribution: 0, socratic_tutor: 0 }), reducer: (_left, right) => right }),
  memoryWritten: Annotation<boolean>({ default: () => false, reducer: (_left, right) => right }),
});
export type AssistantState = typeof LearningAssistantState.State;
