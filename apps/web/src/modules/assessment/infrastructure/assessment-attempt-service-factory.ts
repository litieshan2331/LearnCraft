/**
 * Assessment 作答评分应用服务的基础设施装配入口。
 *
 * 函数：
 * - getAssessmentAttemptService：复用 Web 进程内的作答评分服务实例。
 */

import { AssessmentAttemptService } from "../application/assessment-attempt-service";
import { DrizzleAssessmentAttemptRepository } from "./drizzle-assessment-attempt-repository";

let assessmentAttemptService: AssessmentAttemptService | undefined;

export function getAssessmentAttemptService(): AssessmentAttemptService {
  assessmentAttemptService ??= new AssessmentAttemptService(
    new DrizzleAssessmentAttemptRepository(),
  );
  return assessmentAttemptService;
}
