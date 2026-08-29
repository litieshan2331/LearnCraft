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
    const pitfallsDebug = toText(publicContent.pitfalls_debug);
    const workedExample = toRecord(publicContent.worked_example);
    if (!foundation || !pitfallsDebug || Object.keys(workedExample).length === 0) {
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

function toRecordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}