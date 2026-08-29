/**
 * 节点知识内容查询服务的基础设施装配入口。
 *
 * 导出：
 * - getCardContentQueryService：复用 Web 进程中的内容查询服务实例。
 */

import { CardContentQueryService } from "../application/card-content-query-service";
import { DrizzleCardContentQueryRepository } from "./drizzle-card-content-query-repository";

let cardContentQueryService: CardContentQueryService | undefined;

export function getCardContentQueryService(): CardContentQueryService {
  cardContentQueryService ??= new CardContentQueryService(new DrizzleCardContentQueryRepository());
  return cardContentQueryService;
}