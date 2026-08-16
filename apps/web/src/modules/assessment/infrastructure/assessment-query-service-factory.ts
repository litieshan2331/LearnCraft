/**
 * Assessment 题集读取应用服务的基础设施装配入口。
 *
 * 导出：
 * - getAssessmentQueryService：复用 Web 进程中的题集读取服务实例。
 */

import { AssessmentQueryService } from "../application/assessment-query-service";
import { DrizzleAssessmentQueryRepository } from "./drizzle-assessment-query-repository";

let assessmentQueryService: AssessmentQueryService | undefined;

export function getAssessmentQueryService(): AssessmentQueryService {
  assessmentQueryService ??= new AssessmentQueryService(
    new DrizzleAssessmentQueryRepository(),
  );
  return assessmentQueryService;
}
