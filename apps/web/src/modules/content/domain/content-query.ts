/**
 * 节点知识内容查询领域契约。
 *
 * 导出：
 * - CardContentSnapshot：可供当前用户阅读的已成功内容快照。
 * - CardContentQueryRepository：按所有者读取已成功节点内容的持久化端口。
 * - CardContentQueryServiceError：内容查询稳定错误。
 */

export interface PitfallDebugSnapshot {
  title: string;
  cause: string;
  fix: string;
}

export interface CardContentSnapshot {
  id: string;
  planNodeId: string;
  version: number;
  status: string;
  schemaVersion: string;
  foundation: string;
  workedExample: Record<string, unknown>;
  pitfallsDebug: PitfallDebugSnapshot[];
  sourceRefs: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
  generatedAt: Date | null;
}

export interface CardContentQueryRepository {
  findOwnedReadyContent(ownerId: string, cardContentId: string): Promise<CardContentSnapshot | null>;
}

export type CardContentQueryErrorCode = "CARD_CONTENT_NOT_FOUND";

export class CardContentQueryServiceError extends Error {
  constructor(public readonly code: CardContentQueryErrorCode) {
    super(code);
    this.name = "CardContentQueryServiceError";
  }
}