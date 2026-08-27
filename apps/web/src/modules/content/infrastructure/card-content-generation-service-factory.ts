/**
 * 节点知识内容生成服务的基础设施装配入口。
 *
 * 导出：
 * - getCardContentGenerationService：复用 Web 进程内的内容生成应用服务实例。
 */

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";

import { CardContentGenerationService } from "../application/card-content-generation-service";
import { DrizzleCardContentGenerationContextRepository } from "./drizzle-card-content-generation-context-repository";

let cardContentGenerationService: CardContentGenerationService | undefined;

export function getCardContentGenerationService(): CardContentGenerationService {
  cardContentGenerationService ??= new CardContentGenerationService(
    new DrizzleCardContentGenerationContextRepository(),
    getAgentRunService(),
  );
  return cardContentGenerationService;
}