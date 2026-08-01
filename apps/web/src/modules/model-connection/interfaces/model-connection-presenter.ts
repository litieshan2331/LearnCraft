/**
 * 用户模型连接的 HTTP 响应映射器。
 *
 * 导出：
 * - presentModelConnection：将领域快照转换为不含 API Key 的 snake_case 响应。
 */

import type { ModelConnectionSnapshot } from "../domain/model-connection";

export function presentModelConnection(connection: ModelConnectionSnapshot) {
  return {
    id: connection.id,
    display_name: connection.displayName,
    protocol: connection.protocol,
    base_url: connection.baseUrl,
    default_model_id: connection.defaultModelId,
    status: connection.status,
    is_default: connection.isDefault,
    last_verified_at: connection.lastVerifiedAt?.toISOString() ?? null,
    last_error_code: connection.lastErrorCode,
    created_at: connection.createdAt.toISOString(),
    updated_at: connection.updatedAt.toISOString(),
  };
}
