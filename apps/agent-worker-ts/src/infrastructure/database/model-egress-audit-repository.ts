/**
 * 模型连接受控出网审计的 PostgreSQL 写入器（等价于 Python 的 SqlAlchemyModelEgressAuditRepository）。
 *
 * 职责：把最小安全审计记录写入 public.model_connection_egress_audits。
 * - 只记录 owner_id、connection_id、agent_run_id、host、port、decision、reason_code 七个字段，
 *   **绝不含 API Key、Prompt 或模型正文**；
 * - 与 Python 一致：同一事务内先清理过期行，再插入新行，occurred_at 映射到列 created_at；
 * - 该写入是出网的 fail-closed 前置条件：SafeModelEgressClient 在发请求前调用它，
 *   写入失败即以 MODEL_EGRESS_AUDIT_UNAVAILABLE 拒绝调用。
 *
 * 导出：
 * - PgModelEgressAuditRepository：record（实现 ModelEgressAuditWriter 端口）。
 */

import type { ModelEgressAuditEntry, ModelEgressAuditWriter } from '../llm/safe-egress-client.js';
import type { PoolClientLike, PoolLike } from './agent-run-repository.js';

const SQL_DELETE_EXPIRED = 'DELETE FROM public.model_connection_egress_audits WHERE expires_at <= now()';

const SQL_INSERT_AUDIT = [
  'INSERT INTO public.model_connection_egress_audits',
  '  (owner_id, model_connection_id, agent_run_id, host, port, decision, reason_code, created_at, expires_at)',
  'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + ($8::int * interval \'1 day\'))',
].join('\n');

export class PgModelEgressAuditRepository implements ModelEgressAuditWriter {
  constructor(
    private readonly pool: PoolLike,
    private readonly retentionDays: number,
  ) {}

  async record(entry: ModelEgressAuditEntry): Promise<void> {
    const client: PoolClientLike = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(SQL_DELETE_EXPIRED);
      await client.query(SQL_INSERT_AUDIT, [
        entry.ownerId,
        entry.modelConnectionId,
        entry.agentRunId,
        entry.host,
        entry.port,
        entry.decision,
        entry.reasonCode,
        this.retentionDays,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
