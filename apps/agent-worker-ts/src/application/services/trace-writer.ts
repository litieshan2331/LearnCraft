/**
 * Agent 观测写入端口。
 *
 * 调用顺序：工作流或执行命令调用 `append` 写入运行、模型和工具事件；
 * 未装配观测存储时使用 `createNoopTraceWriter`，不改变 Agent 执行流程。
 */

export type AgentTraceEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'llm.request.started'
  | 'llm.attempt.completed'
  | 'llm.attempt.failed'
  | 'llm.retry'
  | 'llm.fallback'
  | 'tool.started'
  | 'tool.completed';

/** 单条观测事件及其可选时间、用量和定位信息。 */
export interface AgentTraceEventInput {
  runId: string;
  eventType: AgentTraceEventType;
  turnNo?: number;
  stepNo?: number;
  attemptNo?: number;
  startedAt?: Date;
  finishedAt?: Date;
  inputTokens?: number;
  outputTokens?: number;
  payload: Record<string, unknown>;
}

/** Worker 侧观测写入端口。 */
export interface TraceWriter {
  append(event: AgentTraceEventInput): Promise<void>;
}

/** 创建不落库的空观测写入器，供测试和未配置观测时使用。 */
export function createNoopTraceWriter(): TraceWriter {
  return { append: async () => undefined };
}
