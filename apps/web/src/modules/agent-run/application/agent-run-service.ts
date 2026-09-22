/**
 * AgentRun 应用服务。
 *
 * 导出：
 * - AgentRunService：供学习目标、测验、路线和卡片等受信任业务用例创建任务，并提供所有者状态读取与取消。
 */

import { randomUUID } from "node:crypto";

import {
  AgentRunApplicationError,
  type AgentRunInFlightQuery,
  type AgentRunProductionInput,
  type AgentRunProductionResult,
  type AgentRunRepository,
  type AgentRunSnapshot,
} from "../domain/agent-run";

export class AgentRunService {
  constructor(private readonly agentRunRepository: AgentRunRepository) {}

  async request(input: Omit<AgentRunProductionInput, "traceId"> & { traceId?: string }): Promise<AgentRunProductionResult> {
    return this.agentRunRepository.create({
      ...input,
      traceId: input.traceId ?? randomUUID(),
    });
  }

  /** 读取某目标上仍在执行（queued/running）的任务快照；业务用例据此做目标级幂等。 */
  async findInFlightRun(query: AgentRunInFlightQuery): Promise<AgentRunSnapshot | null> {
    return this.agentRunRepository.findInFlightRun(query);
  }

  async getOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunSnapshot> {
    const agentRun = await this.agentRunRepository.findOwnedRun(ownerId, agentRunId);
    if (!agentRun) {
      throw new AgentRunApplicationError("AGENT_RUN_NOT_FOUND");
    }

    return agentRun;
  }

  async cancelOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunSnapshot> {
    const result = await this.agentRunRepository.cancelOwnedRun(ownerId, agentRunId);
    if (!result.agentRun) {
      throw new AgentRunApplicationError("AGENT_RUN_NOT_FOUND");
    }
    if (result.decision === "not_cancellable") {
      throw new AgentRunApplicationError("AGENT_RUN_NOT_CANCELLABLE");
    }

    return result.agentRun;
  }
}
