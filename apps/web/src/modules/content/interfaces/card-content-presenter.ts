/**
 * 节点知识内容公开响应映射器。
 *
 * 导出：
 * - presentCardContent：仅返回可供学习者阅读的内容和来源引用。
 */

import type { CardContentSnapshot } from "../domain/content-query";

export function presentCardContent(content: CardContentSnapshot) {
  return {
    id: content.id,
    plan_node_id: content.planNodeId,
    version: content.version,
    status: content.status,
    schema_version: content.schemaVersion,
    foundation: content.foundation,
    worked_example: content.workedExample,
    pitfalls_debug: content.pitfallsDebug,
    source_refs: content.sourceRefs,
    created_at: content.createdAt.toISOString(),
    updated_at: content.updatedAt.toISOString(),
    generated_at: content.generatedAt?.toISOString() ?? null,
  };
}