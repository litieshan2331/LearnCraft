/**
 * 真实数据库只读冒烟测试（需显式开启，默认跳过）。
 *
 * 目的：在真实 schema 与真实数据上验证 TypeScript 实现，而**不写入任何数据**：
 * - AgentRun Repository 使用的列名与真实表结构一致；
 * - 能从真实的 user_model_connections 记录解密出用户 Provider 凭据。
 *
 * 开启方式（不设置则整个文件跳过）：
 *   AGENT_TS_TEST_DATABASE_URL=<postgres 连接串>
 *   CREDENTIAL_ENCRYPTION_KEY=<Base64 的 32 字节主密钥>
 *   CREDENTIAL_ENCRYPTION_KEY_VERSION=<密钥版本>
 *
 * 注意：本文件只执行 SELECT，绝不 INSERT/UPDATE/DELETE。
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { ModelCredentialDecryptor } from '../../src/infrastructure/llm/credential-decryptor.js';

const { Pool } = pg;

const databaseUrl = process.env.AGENT_TS_TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

const REQUIRED_AGENT_RUN_COLUMNS = [
  'id',
  'owner_id',
  'run_type',
  'status',
  'target_type',
  'target_id',
  'trace_id',
  'retry_count',
  'input_summary_json',
  'output_summary_json',
  'input_tokens',
  'output_tokens',
  'actual_model_profile',
  'error_code',
  'error_summary',
  'started_at',
  'finished_at',
];

const REQUIRED_EVENT_COLUMNS = ['id', 'agent_run_id', 'sequence_no', 'event_type', 'payload_json', 'occurred_at'];

/** 与真实表结构一致：模型名列是 default_model_id（不是 model_id）。 */
interface ModelConnectionRow {
  owner_id: string;
  id: string;
  base_url: string;
  default_model_id: string;
  encrypted_api_key: string;
  api_key_iv: string;
  api_key_auth_tag: string;
  encryption_key_version: string;
}

const SQL_SELECT_CONNECTIONS = "SELECT owner_id, id, base_url, default_model_id, encrypted_api_key, api_key_iv, api_key_auth_tag, encryption_key_version FROM public.user_model_connections WHERE owner_id = ANY($1::uuid[]) AND status = 'active' AND is_default = true LIMIT 5";

const SQL_SELECT_ANY_DEFAULT_CONNECTION = "SELECT owner_id, id, base_url, default_model_id, encrypted_api_key, api_key_iv, api_key_auth_tag, encryption_key_version FROM public.user_model_connections WHERE status = 'active' LIMIT 5";

describe.skipIf(!enabled)('真实数据库只读冒烟', () => {
  it('agent schema 的表结构覆盖 Repository 使用的全部列', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const result = await pool.query(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
        ['agent'],
      );
      const columnsByTable = new Map<string, Set<string>>();
      for (const row of result.rows as Array<{ table_name: string; column_name: string }>) {
        const set = columnsByTable.get(row.table_name) ?? new Set<string>();
        set.add(row.column_name);
        columnsByTable.set(row.table_name, set);
      }

      const runColumns = columnsByTable.get('agent_runs') ?? new Set<string>();
      const eventColumns = columnsByTable.get('agent_run_events') ?? new Set<string>();
      expect([...REQUIRED_AGENT_RUN_COLUMNS].filter((column) => !runColumns.has(column))).toEqual([]);
      expect([...REQUIRED_EVENT_COLUMNS].filter((column) => !eventColumns.has(column))).toEqual([]);
      console.log(
        '  · agent_runs 列数=' + String(runColumns.size) + '，agent_run_events 列数=' + String(eventColumns.size),
      );
    } finally {
      await pool.end();
    }
  });

  it('能从真实的用户模型连接解密出 Provider 凭据（不输出明文）', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const runs = await pool.query(
        'SELECT id, owner_id, status, trace_id FROM agent.agent_runs ORDER BY created_at DESC LIMIT 5',
      );
      const ownerIds = [...new Set((runs.rows as Array<{ owner_id: string }>).map((row) => row.owner_id))];

      // 优先使用真实 AgentRun 的 owner 对应的默认连接；库里没有运行记录时退化为任意一条可用连接。
      let connections =
        ownerIds.length === 0
          ? { rows: [] as ModelConnectionRow[] }
          : ((await pool.query(SQL_SELECT_CONNECTIONS, [ownerIds])) as { rows: ModelConnectionRow[] });
      if (connections.rows.length === 0) {
        connections = (await pool.query(SQL_SELECT_ANY_DEFAULT_CONNECTION)) as { rows: ModelConnectionRow[] };
        if (connections.rows.length > 0) {
          console.log('  · 库中无 AgentRun 记录，改用任意一条 active 模型连接验证解密');
        }
      }
      if (connections.rows.length === 0) {
        console.log('  · 库中没有可用的模型连接，跳过凭据解密验证');
        return;
      }

      const decryptor = ModelCredentialDecryptor.fromEnvironment();
      let decrypted = 0;
      for (const row of connections.rows) {
        const plaintext = decryptor.decrypt(row.owner_id, {
          ciphertext_base64: row.encrypted_api_key,
          iv_base64: row.api_key_iv,
          auth_tag_base64: row.api_key_auth_tag,
          encryption_key_version: row.encryption_key_version,
        });
        expect(plaintext.length).toBeGreaterThan(0);
        decrypted += 1;
        // 只输出长度与前缀，绝不输出明文。
        console.log(
          '  · 连接 ' + row.id + ' 解密成功：明文长度=' + String(plaintext.length) +
            '，前缀=' + plaintext.slice(0, 3) + '***，模型=' + row.default_model_id,
        );
      }
      console.log(
        '  · 共解密 ' + String(decrypted) + ' 条真实凭据；AgentRun 样本数=' + String(runs.rows.length),
      );
    } finally {
      await pool.end();
    }
  });
});
