/**
 * Agent 工作流到 BullMQ 资源池的路由规则。
 *
 * 调用顺序：Dispatcher/Publisher 调用 `workflowPoolForRunType`，根据 run_type 选择短任务池或长任务池；
 * 未知工作流由 `UnknownWorkflowPoolError` 标记；Dispatcher 为保持旧任务可终态失败，会将其交给短任务 Worker。
 *
 * 当前分池：assessment_generate、posttest_generate → short；
 * plan_generate、card_content_generate → long。
 */

export type WorkflowPool = 'short' | 'long';

const SHORT_WORKFLOW_RUN_TYPES = new Set(['assessment_generate', 'posttest_generate']);
const LONG_WORKFLOW_RUN_TYPES = new Set(['plan_generate', 'card_content_generate']);

/** 未注册工作流类型错误，供 Outbox 投递阶段识别并沿用旧的 Worker 失败语义。 */
export class UnknownWorkflowPoolError extends Error {
  constructor(readonly runType: string) {
    super('未配置工作流资源池：' + runType);
    this.name = 'UnknownWorkflowPoolError';
  }
}

/** 根据 AgentRun 的 run_type 返回对应资源池。 */
export function workflowPoolForRunType(runType: string): WorkflowPool {
  if (SHORT_WORKFLOW_RUN_TYPES.has(runType)) {
    return 'short';
  }
  if (LONG_WORKFLOW_RUN_TYPES.has(runType)) {
    return 'long';
  }
  throw new UnknownWorkflowPoolError(runType);
}
