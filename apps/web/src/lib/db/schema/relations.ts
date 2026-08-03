/**
 * LearnCraft P0 表关系定义。
 *
 * 导出：
 * - 各限界上下文表的 Drizzle relations，用于类型化关联查询；数据库约束仍由各表的外键承担。
 */

import { relations } from "drizzle-orm";

import { agentRunEvents, agentRuns } from "./agent";
import {
  assessmentAnswers,
  assessmentAttempts,
  assessmentItems,
  assessments,
} from "./assessment";
import {
  cardContentReferences,
  cardContents,
  contentChunks,
  contentDocuments,
  contentSources,
} from "./content";
import { authSessions, users } from "./identity";
import { modelConnectionEgressAudits, userModelConnections } from "./model-connection";
import { adaptationEvents, learningPlans, planNodePrerequisites, planNodes } from "./planning";
import { codeRuns } from "./practice";
import { learnerProfiles, learningGoals } from "./profile";

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, {
    fields: [authSessions.userId],
    references: [users.id],
  }),
}));

export const learnerProfilesRelations = relations(learnerProfiles, ({ one }) => ({
  user: one(users, {
    fields: [learnerProfiles.userId],
    references: [users.id],
  }),
}));

export const learningGoalsRelations = relations(learningGoals, ({ one }) => ({
  owner: one(users, {
    fields: [learningGoals.ownerId],
    references: [users.id],
  }),
  modelConnection: one(userModelConnections, {
    fields: [learningGoals.modelConnectionId],
    references: [userModelConnections.id],
  }),
}));

export const userModelConnectionsRelations = relations(userModelConnections, ({ one }) => ({
  owner: one(users, {
    fields: [userModelConnections.ownerId],
    references: [users.id],
  }),
}));

export const modelConnectionEgressAuditsRelations = relations(
  modelConnectionEgressAudits,
  ({ one }) => ({
    owner: one(users, {
      fields: [modelConnectionEgressAudits.ownerId],
      references: [users.id],
    }),
  }),
);

export const learningPlansRelations = relations(learningPlans, ({ one }) => ({
  owner: one(users, {
    fields: [learningPlans.ownerId],
    references: [users.id],
  }),
  goal: one(learningGoals, {
    fields: [learningPlans.goalId],
    references: [learningGoals.id],
  }),
}));

export const planNodesRelations = relations(planNodes, ({ one }) => ({
  owner: one(users, {
    fields: [planNodes.ownerId],
    references: [users.id],
  }),
  plan: one(learningPlans, {
    fields: [planNodes.planId],
    references: [learningPlans.id],
  }),
  parent: one(planNodes, {
    fields: [planNodes.parentNodeId],
    references: [planNodes.id],
    relationName: "plan_node_hierarchy",
  }),
}));

export const planNodePrerequisitesRelations = relations(
  planNodePrerequisites,
  ({ one }) => ({
    node: one(planNodes, {
      fields: [planNodePrerequisites.nodeId],
      references: [planNodes.id],
      relationName: "plan_node_dependent",
    }),
    prerequisiteNode: one(planNodes, {
      fields: [planNodePrerequisites.prerequisiteNodeId],
      references: [planNodes.id],
      relationName: "plan_node_prerequisite",
    }),
  }),
);

export const adaptationEventsRelations = relations(adaptationEvents, ({ one }) => ({
  owner: one(users, {
    fields: [adaptationEvents.ownerId],
    references: [users.id],
  }),
  plan: one(learningPlans, {
    fields: [adaptationEvents.planId],
    references: [learningPlans.id],
  }),
  triggerNode: one(planNodes, {
    fields: [adaptationEvents.triggerNodeId],
    references: [planNodes.id],
  }),
}));

export const assessmentsRelations = relations(assessments, ({ one }) => ({
  owner: one(users, {
    fields: [assessments.ownerId],
    references: [users.id],
  }),
  goal: one(learningGoals, {
    fields: [assessments.goalId],
    references: [learningGoals.id],
  }),
  plan: one(learningPlans, {
    fields: [assessments.planId],
    references: [learningPlans.id],
  }),
  planNode: one(planNodes, {
    fields: [assessments.planNodeId],
    references: [planNodes.id],
  }),
}));

export const assessmentItemsRelations = relations(assessmentItems, ({ one }) => ({
  assessment: one(assessments, {
    fields: [assessmentItems.assessmentId],
    references: [assessments.id],
  }),
}));

export const assessmentAttemptsRelations = relations(assessmentAttempts, ({ one }) => ({
  owner: one(users, {
    fields: [assessmentAttempts.ownerId],
    references: [users.id],
  }),
  assessment: one(assessments, {
    fields: [assessmentAttempts.assessmentId],
    references: [assessments.id],
  }),
}));

export const assessmentAnswersRelations = relations(assessmentAnswers, ({ one }) => ({
  attempt: one(assessmentAttempts, {
    fields: [assessmentAnswers.attemptId],
    references: [assessmentAttempts.id],
  }),
  assessmentItem: one(assessmentItems, {
    fields: [assessmentAnswers.assessmentItemId],
    references: [assessmentItems.id],
  }),
}));

export const contentDocumentsRelations = relations(contentDocuments, ({ one }) => ({
  source: one(contentSources, {
    fields: [contentDocuments.sourceId],
    references: [contentSources.id],
  }),
}));

export const contentChunksRelations = relations(contentChunks, ({ one }) => ({
  document: one(contentDocuments, {
    fields: [contentChunks.documentId],
    references: [contentDocuments.id],
  }),
}));

export const cardContentsRelations = relations(cardContents, ({ one }) => ({
  owner: one(users, {
    fields: [cardContents.ownerId],
    references: [users.id],
  }),
  planNode: one(planNodes, {
    fields: [cardContents.planNodeId],
    references: [planNodes.id],
  }),
}));

export const cardContentReferencesRelations = relations(cardContentReferences, ({ one }) => ({
  cardContent: one(cardContents, {
    fields: [cardContentReferences.cardContentId],
    references: [cardContents.id],
  }),
  contentSource: one(contentSources, {
    fields: [cardContentReferences.contentSourceId],
    references: [contentSources.id],
  }),
  contentDocument: one(contentDocuments, {
    fields: [cardContentReferences.contentDocumentId],
    references: [contentDocuments.id],
  }),
  contentChunk: one(contentChunks, {
    fields: [cardContentReferences.contentChunkId],
    references: [contentChunks.id],
  }),
}));

export const codeRunsRelations = relations(codeRuns, ({ one }) => ({
  owner: one(users, {
    fields: [codeRuns.ownerId],
    references: [users.id],
  }),
  goal: one(learningGoals, {
    fields: [codeRuns.goalId],
    references: [learningGoals.id],
  }),
  planNode: one(planNodes, {
    fields: [codeRuns.planNodeId],
    references: [planNodes.id],
  }),
  cardContent: one(cardContents, {
    fields: [codeRuns.cardContentId],
    references: [cardContents.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  owner: one(users, {
    fields: [agentRuns.ownerId],
    references: [users.id],
  }),
  modelConnection: one(userModelConnections, {
    fields: [agentRuns.modelConnectionId],
    references: [userModelConnections.id],
  }),
}));

export const agentRunEventsRelations = relations(agentRunEvents, ({ one }) => ({
  agentRun: one(agentRuns, {
    fields: [agentRunEvents.agentRunId],
    references: [agentRuns.id],
  }),
}));
