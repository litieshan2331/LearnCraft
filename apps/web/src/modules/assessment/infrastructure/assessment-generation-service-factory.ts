/**
 * Assessment 生成应用服务的基础设施装配入口。
 *
 * 导出：
 * - getAssessmentGenerationService：复用 Web 进程中的生成请求服务实例。
 */

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";

import { AssessmentGenerationService } from "../application/assessment-generation-service";
import { DrizzleAssessmentGenerationContextRepository } from "./drizzle-assessment-generation-context-repository";

let assessmentGenerationService: AssessmentGenerationService | undefined;

export function getAssessmentGenerationService(): AssessmentGenerationService {
  assessmentGenerationService ??= new AssessmentGenerationService(
    new DrizzleAssessmentGenerationContextRepository(),
    getAgentRunService(),
  );
  return assessmentGenerationService;
}
