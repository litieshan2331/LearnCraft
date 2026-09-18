/**
 * 真实用例共用的 Tavily 工具网关工厂。
 *
 * 职责：按运行所属账户构造真实的 Tavily 网关，配额走 TAVILY_QUOTA_REDIS_URL；
 * 未配置配额 Redis 时使用「永远不可用」的计数器，使工具调用返回受控错误而不是绕过配额。
 *
 * 导出：
 * - createLiveTavilyToolGatewayFactory：供 live 用例注入工作流的 createToolGateway。
 */

import { readTavilyToolSettings } from '../../src/bootstrap/config.js';
import {
  RedisDailyQuotaCounter,
  TavilyToolGateway,
  type DailyQuotaCounter,
} from '../../src/infrastructure/mcp/tavily-tool-gateway.js';

export function createLiveTavilyToolGatewayFactory(): (ownerId: string) => TavilyToolGateway {
  const environment = readTavilyToolSettings();
  const quota: DailyQuotaCounter =
    environment.quotaRedisUrl === null
      ? { increment: async () => null, decrement: async () => undefined }
      : new RedisDailyQuotaCounter(environment.quotaRedisUrl);
  return (ownerId: string) =>
    new TavilyToolGateway({
      settings: {
        apiKey: environment.apiKey,
        ownerId,
        dailyLimit: environment.dailyLimit,
        quotaKeyPrefix: environment.quotaKeyPrefix,
        searchMaxResults: environment.searchMaxResults,
        extractTopResults: environment.extractTopResults,
        extractChunksPerSource: environment.extractChunksPerSource,
        proxyUrl: environment.proxyUrl,
      },
      quota,
    });
}
