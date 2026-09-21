/**
 * AgentRun 实时进度事件（临时通道，仅用于生成过程中的前端呈现）。
 *
 * 职责：定义 worker 上报、web 转发给浏览器的步骤级、工具级与思考原文事件契约，以及上报端口。
 * 三条硬约束：
 * 1. 只上报步骤、工具元数据与**模型思考原文**（thinking.completed）；提示词、生成正文与工具返回内容一律不上报。
 *    思考原文是本契约中唯一允许携带模型原文的事件，仅用于生成过程中的前端呈现；
 * 2. **不落库、不写日志、不入浏览器存储**：事件只经 Redis Pub/Sub 临时转发，生成结束即消失；
 * 3. **上报不得影响 AgentRun**：report 是同步 fire-and-forget，实现必须自行吞掉所有错误。
 *
 * 前端负责把 step code 映射为面向用户的中文文案，worker 不发用户可见文案。
 *
 * 导出：
 * - AgentProgressStep：步骤 code 集合。
 * - AgentProgressEvent：线上事件结构（含协议版本与运行内序号）。
 * - AgentProgressReporter：上报端口（report）。
 * - createNoopAgentProgressReporter：未装配进度通道时的空实现。
 */

export type AgentProgressStep =
  /** 已领取运行，正在取模型连接与解密凭据。 */
  | 'run.preparing'
  /** 第 N 轮模型调用开始。 */
  | 'turn.started'
  /** 模型要求调用工具（tavily_search）。 */
  | 'tool.called'
  /** 工具返回（成功或受控失败）。 */
  | 'tool.completed'
  /** 思考增量（data.text）：流式生成过程中按块推送，供前端边生成边显示。 */
  | 'thinking.delta'
  /** 一轮思考结束，携带该轮模型思考原文（data.text）：作为权威整段，前端用它覆盖本轮增量。 */
  | 'thinking.completed'
  /** 模型输出未通过结构校验，字段路径将回灌同一会话。 */
  | 'validation.failed'
  /** 模型在同一会话内自纠。 */
  | 'turn.self_correcting'
  /** 即将调用内部接口持久化结果。 */
  | 'result.persisting'
  /** 结果已持久化，运行成功。 */
  | 'run.completed'
  /** 运行以错误结束（ReAct 轮数耗尽或模型网关错误）。 */
  | 'run.failed';

/** 事件参数：只允许标量值，键集合由 step 决定（见各 step 的定义处）。 */
export type AgentProgressData = Record<string, string | number | boolean>;

export interface AgentProgressEvent {
  /** 协议版本，便于以后演进而不破坏前端。 */
  v: 1;
  step: AgentProgressStep;
  /** 事件产生时间（ISO 字符串）。 */
  at: string;
  /** 运行内的单调递增序号，仅供前端排序与去重；不落库。 */
  seq: number;
  /** 可选结构化参数。 */
  data?: AgentProgressData;
}

/** 进度上报端口：fire-and-forget，调用方不等待、不处理错误。 */
export interface AgentProgressReporter {
  report(step: AgentProgressStep, data?: AgentProgressData): void;
}

/** 未装配进度通道（或通道不可用）时使用的空实现。 */
export function createNoopAgentProgressReporter(): AgentProgressReporter {
  return { report: () => undefined };
}
