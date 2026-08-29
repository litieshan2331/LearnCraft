/**
 * 节点知识内容查询应用服务。
 *
 * 导出：
 * - CardContentQueryService：按当前用户所有权读取已成功的节点内容。
 */

import {
  CardContentQueryServiceError,
  type CardContentQueryRepository,
  type CardContentSnapshot,
} from "../domain/content-query";

export class CardContentQueryService {
  constructor(private readonly repository: CardContentQueryRepository) {}

  async getOwnedReadyContent(ownerId: string, cardContentId: string): Promise<CardContentSnapshot> {
    const content = await this.repository.findOwnedReadyContent(ownerId, cardContentId);
    if (!content) {
      throw new CardContentQueryServiceError("CARD_CONTENT_NOT_FOUND");
    }
    return content;
  }
}