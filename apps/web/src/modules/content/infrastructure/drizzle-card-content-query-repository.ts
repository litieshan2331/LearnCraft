/**
 * 节点知识内容查询的 Drizzle 适配器。
 *
 * 导出：
 * - DrizzleCardContentQueryRepository：按所有者读取 ready 卡片的公开内容字段。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { cardContents } from "@/lib/db/schema";

import type {
  CardContentQueryRepository,
  CardContentSnapshot,
} from "../domain/content-query";
import { normalizeWorkedExample } from "./card-content-worked-example-normalizer";

export class DrizzleCardContentQueryRepository implements CardContentQueryRepository {
  async findOwnedReadyContent(ownerId: string, cardContentId: string): Promise<CardContentSnapshot | null> {
    const database = getDatabase();
    const [content] = await database
      .select()
      .from(cardContents)
      .where(and(
        eq(cardContents.id, cardContentId),
        eq(cardContents.ownerId, ownerId),
        eq(cardContents.status, "ready"),
      ))
      .limit(1);

    if (!content) {
      return null;
    }

    const publicContent = toRecord(content.publicContentJson);
    const foundation = toText(publicContent.foundation);
    const pitfallsDebug = toPitfallDebugList(publicContent.pitfalls_debug);
    // v2 直接映射；v1（历史数据）在读侧按 `// 路径` 拆分归一化——v1 内容不重新生成，这条分支长期存在。
    const workedExample = normalizeWorkedExample({
      raw: publicContent.worked_example,
      schemaVersion: content.schemaVersion,
    });
    if (!foundation || !pitfallsDebug || pitfallsDebug.length === 0 || workedExample === null) {
      return null;
    }

    return {
      id: content.id,
      planNodeId: content.planNodeId,
      version: content.version,
      status: content.status,
      schemaVersion: content.schemaVersion,
      foundation,
      workedExample,
      pitfallsDebug,
      sourceRefs: toRecordList(publicContent.source_refs),
      createdAt: content.createdAt,
      updatedAt: content.updatedAt,
      generatedAt: content.generatedAt,
    };
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toPitfallDebugList(value: unknown): Array<{ title: string; cause: string; fix: string }> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const items = value.filter((item): item is { title: string; cause: string; fix: string } =>
    typeof item === "object" && item !== null && !Array.isArray(item)
    && typeof item.title === "string" && item.title.trim().length > 0
    && typeof item.cause === "string" && item.cause.trim().length > 0
    && typeof item.fix === "string" && item.fix.trim().length > 0,
  );
  return items.length === value.length ? items : null;
}
function toRecordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}