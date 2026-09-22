/**
 * 学习计划与节点的公开响应映射器。
 *
 * 导出：
 * - presentLearningPlan：返回路线、章节和前置节点 ID。
 * - presentPlanNode：返回单个章节及其路线信息。
 */

import type { LearningPlanSnapshot, PlanNodeSnapshot } from "../domain/plan-query";

export function presentLearningPlan(plan: LearningPlanSnapshot) {
  return {
    id: plan.id,
    goal_id: plan.goalId,
    version: plan.version,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    profile_version: plan.profileVersion,
    schema_version: plan.schemaVersion,
    nodes: plan.nodes.map(presentPlanNodeInPlan),
    created_at: plan.createdAt.toISOString(),
    updated_at: plan.updatedAt.toISOString(),
  };
}

export function presentPlanNode(node: PlanNodeSnapshot) {
  return {
    id: node.id,
    goal_id: node.goalId,
    plan_id: node.planId,
    plan_title: node.planTitle,
    plan_status: node.planStatus,
    node_key: node.nodeKey,
    ordinal: node.ordinal,
    title: node.title,
    node_brief: node.nodeBrief,
    learning_objective: node.learningObjective,
    rationale: node.rationale,
    difficulty: node.difficulty,
    estimated_minutes: node.estimatedMinutes,
    completion_criteria: node.completionCriteria,
    status: node.status,
    content_status: node.contentStatus,
    card_content_id: node.cardContentId,
    latest_content_run_id: node.latestContentRunId,
    latest_posttest_run_id: node.latestPosttestRunId,
    prerequisite_node_ids: node.prerequisiteNodeIds,
  };
}

function presentPlanNodeInPlan(node: LearningPlanSnapshot["nodes"][number]) {
  return {
    id: node.id,
    plan_id: node.planId,
    node_key: node.nodeKey,
    ordinal: node.ordinal,
    title: node.title,
    node_brief: node.nodeBrief,
    learning_objective: node.learningObjective,
    rationale: node.rationale,
    difficulty: node.difficulty,
    estimated_minutes: node.estimatedMinutes,
    completion_criteria: node.completionCriteria,
    status: node.status,
    content_status: node.contentStatus,
    card_content_id: node.cardContentId,
    prerequisite_node_ids: node.prerequisiteNodeIds,
  };
}