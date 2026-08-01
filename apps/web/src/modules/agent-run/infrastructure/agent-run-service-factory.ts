/**
 * AgentRun 应用服务的基础设施装配入口。
 *
 * 导出：
 * - getAgentRunService：在 Web 进程内复用已装配的 AgentRun 应用服务。
 */

import { AgentRunService } from "../application/agent-run-service";
import { DrizzleAgentRunRepository } from "./drizzle-agent-run-repository";

let agentRunService: AgentRunService | undefined;

export function getAgentRunService(): AgentRunService {
  agentRunService ??= new AgentRunService(new DrizzleAgentRunRepository());
  return agentRunService;
}
