/**
 * 节点后测生成服务的基础设施装配入口。
 *
 * 导出：
 * - getPosttestGenerationService：复用 Web 进程中的节点后测生成服务实例。
 */

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";

import { PosttestGenerationService } from "../application/posttest-generation-service";
import { DrizzlePosttestGenerationContextRepository } from "./drizzle-posttest-generation-context-repository";

let posttestGenerationService: PosttestGenerationService | undefined;

export function getPosttestGenerationService(): PosttestGenerationService {
  posttestGenerationService ??= new PosttestGenerationService(
    new DrizzlePosttestGenerationContextRepository(),
    getAgentRunService(),
  );
  return posttestGenerationService;
}