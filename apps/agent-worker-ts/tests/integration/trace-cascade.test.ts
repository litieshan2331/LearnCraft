/** 真实 PostgreSQL 观测事件级联删除测试，默认跳过，避免无测试库时阻塞单元测试。 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.AGENT_TS_TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;
const { Pool } = pg;

describe.skipIf(!enabled)('agent_trace_events 级联删除', () => {
  it('外键约束声明为 ON DELETE CASCADE', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const result = await pool.query<{ delete_rule: string }>(
        `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = rc.constraint_name
          AND tc.constraint_schema = rc.constraint_schema
         WHERE tc.table_schema = 'agent'
           AND tc.table_name = 'agent_trace_events'
           AND tc.constraint_type = 'FOREIGN KEY'`,
      );
      expect(result.rows.map((row) => row.delete_rule)).toContain('CASCADE');
    } finally {
      await pool.end();
    }
  });

  it('删除 AgentRun 时硬删除其完整观测事件', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query('BEGIN');
      const run = await pool.query<{ id: string }>(
        'SELECT id FROM agent.agent_runs ORDER BY created_at DESC LIMIT 1',
      );
      const runId = run.rows[0]?.id;
      if (runId === undefined) return;

      await pool.query(
        `INSERT INTO agent.agent_trace_events
          (agent_run_id, sequence_no, event_type, payload_json)
         VALUES ($1, 1, 'run.started', '{}'::jsonb)`,
        [runId],
      );
      await pool.query('DELETE FROM agent.agent_runs WHERE id = $1', [runId]);
      const remaining = await pool.query(
        'SELECT 1 FROM agent.agent_trace_events WHERE agent_run_id = $1',
        [runId],
      );
      expect(remaining.rowCount).toBe(0);
    } finally {
      await pool.query('ROLLBACK').catch(() => undefined);
      await pool.end();
    }
  });
});
