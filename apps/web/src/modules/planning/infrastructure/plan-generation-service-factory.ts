/**
 * 学习路线生成服务的基础设施装配入口。
 *
 * 导出：
 * - getPlanGenerationService：复用 Web 进程中的路线生成服务实例。
 */

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";

import { PlanGenerationService } from "../application/plan-generation-service";
import { DrizzlePlanGenerationContextRepository } from "./drizzle-plan-generation-context-repository";

let planGenerationService: PlanGenerationService | undefined;

export function getPlanGenerationService(): PlanGenerationService {
  planGenerationService ??= new PlanGenerationService(
    new DrizzlePlanGenerationContextRepository(),
    getAgentRunService(),
  );
  return planGenerationService;
}