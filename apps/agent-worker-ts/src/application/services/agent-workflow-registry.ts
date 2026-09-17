/**
 * AgentRun 工作流注册表（等价于 Python 的 BaseAgent 路由边界）。
 *
 * 职责：只做 run_type 到工作流的映射，不包含任何业务规则；未注册的 run_type 由命令层转为
 * AGENT_RUN_WORKFLOW_NOT_REGISTERED 的不可重试失败，绝不伪造成功结果。
 *
 * 导出：
 * - AgentWorkflowRegistry：可注册与解析工作流的实现。
 */

import type { AgentWorkflow, WorkflowRegistryPort } from '../commands/execute-agent-run.js';

export class AgentWorkflowRegistry implements WorkflowRegistryPort {
  private readonly workflows = new Map<string, AgentWorkflow>();

  /** 注册一个 run_type 的工作流；重复注册视为编码错误。 */
  register(runType: string, workflow: AgentWorkflow): void {
    if (this.workflows.has(runType)) {
      throw new Error('run_type=' + runType + ' 的工作流已注册。');
    }
    this.workflows.set(runType, workflow);
  }

  resolve(runType: string): AgentWorkflow | null {
    return this.workflows.get(runType) ?? null;
  }

  /** 已注册的 run_type 列表，供健康检查与排障使用。 */
  registeredRunTypes(): string[] {
    return [...this.workflows.keys()].sort();
  }
}
