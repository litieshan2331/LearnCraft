/**
 * 学习助手独立轨迹与实际模型请求计数的 PostgreSQL 实现。
 * 调用顺序：reserveModelAttempt 原子记录模型尝试 → append 事务写嵌套事件及用量 → listOwnedEvents 内部查询。
 * 不访问旧四工作流 agent_runs，不保存连接密钥；连接池由装配方统一关闭。
 */
import type { AgentTraceEventInput, TraceWriter } from '../../application/services/trace-writer.js';
import type { TracePool } from './agent-trace-writer.js';
import type { RunInput } from '../../workflows/learning-assistant/schemas/index.js';

/** 学习助手运行存储；调用计数保存在业务运行记录，Checkpoint 回滚也不会抹掉观测数据。 */
export class PgLearningAssistantRuntimeStore implements TraceWriter {
  /** 使用现有连接池，所有身份来自服务端运行参数。 */
  constructor(private readonly pool: TracePool) {}

  /** 原子记录一次实际请求；ReAct 上限由图的 Agent 状态控制，此处不设置统一业务上限。 */
  async reserveModelAttempt(input: RunInput): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`UPDATE public.learning_assistant_runs
        SET model_call_count = model_call_count + 1, updated_at = now()
        WHERE id = $1 AND owner_id = $2 AND conversation_id = $3
          AND status = 'running'
        RETURNING model_call_count`, [input.run_id, input.owner_id, input.conversation_id]);
      if (result.rows.length > 0) return Number(result.rows[0]?.model_call_count);
      const run = await client.query(`SELECT model_call_count, status FROM public.learning_assistant_runs
        WHERE id = $1 AND owner_id = $2 AND conversation_id = $3`, [input.run_id, input.owner_id, input.conversation_id]);
      throw new Error('学习助手运行不存在、身份不匹配或尚未处于 running 状态');
    } finally { client.release(); }
  }

  /** 锁本学习助手 run 分配序号，并在同事务累计模型用量和工具次数。 */
  async append(event: AgentTraceEventInput): Promise<void> {
    if (event.spanId === undefined || event.agentName === undefined) throw new Error('学习助手完整轨迹缺少 span 或 Agent 名称');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query('SELECT id FROM public.learning_assistant_runs WHERE id = $1 FOR UPDATE', [event.runId]);
      if (run.rows.length === 0) throw new Error('学习助手运行不存在');
      await client.query(`INSERT INTO agent.learning_assistant_trace_events
        (run_id, sequence_no, event_type, span_id, parent_span_id, agent_name, turn_no, attempt_no,
          started_at, finished_at, input_tokens, output_tokens, payload_json)
        SELECT $1, COALESCE(MAX(sequence_no), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
        FROM agent.learning_assistant_trace_events WHERE run_id = $1`, [event.runId, event.eventType, event.spanId, event.parentSpanId ?? null, event.agentName,
        event.turnNo ?? null, event.attemptNo ?? null, event.startedAt ?? null, event.finishedAt ?? null,
        event.inputTokens ?? null, event.outputTokens ?? null, JSON.stringify(event.payload)]);
      const input = event.eventType === 'llm.attempt.completed' ? event.inputTokens ?? 0 : 0;
      const output = event.eventType === 'llm.attempt.completed' ? event.outputTokens ?? 0 : 0;
      const tools = event.eventType === 'tool.started' ? 1 : 0;
      if (input !== 0 || output !== 0 || tools !== 0) {
        await client.query(`UPDATE public.learning_assistant_runs SET input_tokens = input_tokens + $2,
          output_tokens = output_tokens + $3, tool_call_count = tool_call_count + $4, updated_at = now() WHERE id = $1`, [event.runId, input, output, tools]);
      }
      // 学习助手独立摘要仅由实际完成的工具轨迹产生，不混入旧工作流统计。
      if (event.eventType === 'tool.completed') {
        const toolName = event.payload.toolName;
        const column = toolName === 'load_skill' ? 'skill_summary_json'
          : toolName === 'tavily_search' ? 'tavily_summary_json'
            : toolName === 'analyze_wrong_answer' || toolName === 'generate_socratic_question' ? 'sub_agent_summary_json' : null;
        if (column !== null) {
          await client.query(`UPDATE public.learning_assistant_runs SET ${column} = ${column} || $2::jsonb,
            updated_at = now() WHERE id = $1`, [event.runId, JSON.stringify([{ toolName, spanId: event.spanId, agentName: event.agentName, result: event.payload.result }])]);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 保留原始错误。 */ }
      throw error;
    } finally { client.release(); }
  }

  /** 供内部观测端点分页查询；必须传入已鉴权的所属用户，不能直接用于公开消息接口。 */
  async listOwnedEvents(ownerId: string, runId: string, afterSequence = 0, limit = 100): Promise<Record<string, unknown>[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`SELECT t.* FROM agent.learning_assistant_trace_events t
        JOIN public.learning_assistant_runs r ON r.id = t.run_id
        WHERE r.owner_id = $1 AND r.id = $2 AND t.sequence_no > $3
        ORDER BY t.sequence_no LIMIT $4`, [ownerId, runId, Math.max(0, afterSequence), Math.max(1, Math.min(200, limit))]);
      return result.rows;
    } finally { client.release(); }
  }
}
