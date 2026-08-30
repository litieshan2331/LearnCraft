/**
 * Assessment 题集读取应用服务。
 *
 * 导出：
 * - AssessmentQueryService：仅向题集所有者返回不含答案的公开题集快照。
 */

import {
  AssessmentQueryApplicationError,
  type AssessmentQueryRepository,
  type AssessmentSnapshot,
  type PosttestAssessmentSummary,
} from "../domain/assessment-query";

export class AssessmentQueryService {
  constructor(private readonly repository: AssessmentQueryRepository) {}

  async getOwnedAssessment(ownerId: string, assessmentId: string): Promise<AssessmentSnapshot> {
    const assessment = await this.repository.findOwnedAssessment(ownerId, assessmentId);
    if (!assessment) {
      throw new AssessmentQueryApplicationError("ASSESSMENT_NOT_FOUND");
    }

    return assessment;
  }
  async listOwnedPosttestsByNode(ownerId: string, planNodeId: string): Promise<PosttestAssessmentSummary[]> {
    return this.repository.findOwnedPosttestsByNode(ownerId, planNodeId);
  }
}
