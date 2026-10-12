/**
 * 学习助手图行为验收；使用真实 LangGraph 与假模型/业务端口，不调用付费模型。
 * 调用顺序：fixture 装配 → 普通回复/串行委派 → 子工具权限 → 输出修复 → 20轮窗口 → 崩溃恢复/幂等。
 */
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { AgentTraceEventInput } from '../src/application/services/trace-writer.js';
import type { ModelCompletionRequest, ModelMessage } from '../src/infrastructure/llm/model-gateway.js';
import { createLearningAssistantGraph, runLearningAssistant } from '../src/workflows/learning-assistant/graph.js';
import { modelBudgetExceeded } from '../src/workflows/learning-assistant/agents/index.js';
import type { LearningAssistantDependencies, MemoryCandidate } from '../src/workflows/learning-assistant/ports.js';
import { MainResponseSchema, type RunInput } from '../src/workflows/learning-assistant/schemas/index.js';
import { recentModelMessages, type ConversationMessage } from '../src/workflows/learning-assistant/state.js';

const MAIN = { intent: 'programming', explanation: '循环的边界应小于数组长度。', primary_question: null, next_action: 'answer', stage: 'context_loaded' };
const VERIFICATION = { status: 'not_verified', conclusion: '需要推演证据', evidence_ids: [], demonstrated_progress: false };
const ATTRIBUTION = { status: 'insufficient_evidence', hypotheses: [], verification_direction: '核对最后一次迭代', verification: VERIFICATION };
const TUTOR = { primary_question: '最后一次迭代的下标是多少？', hint: '从边界入手。', hint_level: 0, next_verification_target: '正确推演边界', verification: VERIFICATION };

/** 构造结构化模型回复。 */
function json(value: unknown): ModelMessage { return { role: 'assistant', content: JSON.stringify(value) }; }
/** 构造 Function Calling 回复。 */
function tool(name: string, args: unknown = {}, id: string = randomUUID()): ModelMessage {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] };
}
/** 装配可注入模型响应、预算、持久化故障的测试端口。 */
function fixture(script: Array<ModelMessage | Error>) {
  const calls: ModelCompletionRequest[] = [];
  const events: AgentTraceEventInput[] = [];
  const persisted = new Map<string, ConversationMessage>();
  const memory = new Map<string, MemoryCandidate>();
  const toolNames: string[] = [];
  const loaded: string[] = [];
  const budget = new Map<string, number>();
  const input: RunInput = { run_id: randomUUID(), conversation_id: randomUUID(), owner_id: randomUUID(), connection_id: randomUUID(), model_id: 'test', question_id: randomUUID(), message: { id: randomUUID(), turn_no: 1, content: '为什么会越界' } };
  const deps: LearningAssistantDependencies = {
    checkpointer: new MemorySaver(),
    connection: { ownerId: input.owner_id, connectionId: input.connection_id, modelId: input.model_id, apiKey: 'secret-not-in-checkpoint', baseUrl: 'https://example.com' },
    trace: { /** 收集完整事件。 */ async append(event) { events.push(event); } },
    /** 按 run 持久模拟实际请求预算。 */ async reserveModelAttempt(run) {
      const count = budget.get(run.run_id) ?? 0;
      if (count >= 20) throw modelBudgetExceeded();
      budget.set(run.run_id, count + 1); return count + 1;
    },
    model: { /** 模拟实际网关钩子、轨迹与结构化返回。 */ async complete(request) {
      await request.beforeModelAttempt?.(); calls.push(request);
      await request.traceWriter?.append({ runId: request.agentRunId, eventType: 'llm.request.started', payload: { messages: request.messages, tools: request.tools } });
      const message = script.shift();
      if (message instanceof Error) throw message;
      if (message === undefined) throw new Error('测试模型响应耗尽');
      await request.traceWriter?.append({ runId: request.agentRunId, eventType: 'llm.attempt.completed', inputTokens: 2, outputTokens: 3, payload: { message } });
      return { message, usage: { inputTokens: 2, outputTokens: 3 }, finishReason: 'stop' };
    } },
    skills: {
      /** 返回首层 Skill 摘要。 */ listSkills: () => [],
      /** 记录按需 Skill 加载。 */ loadSkill(id) { loaded.push(id); return '一次只提出一个主要问题'; },
    },
    tavily: { /** 模拟共享 Tavily 配额失败，不新增运行次数限制。 */ async execute() { return { ok: false, code: 'DAILY_LIMIT', message: '当日配额用尽', data: {} }; } },
    /** 根据服务端身份返回业务事实。 */ async readBusinessTool(name, run) { expect(run.owner_id).toBe(input.owner_id); toolNames.push(name); return { data: { text: '服务端事实' }, evidence: [] }; },
    /** 冷启动历史由测试按需覆盖。 */ async loadInitialMessages() { return []; },
    /** 固定 ID 模拟数据库幂等。 */ async persistMessages(_run, messages) { for (const message of messages) persisted.set(message.id, message); },
    /** 服务端独立判断来源及表现。 */ async validateLearningMemory() { return true; },
    /** 固定 run ID 幂等写入。 */ async persistLearningMemory(run, candidate) { memory.set(run.run_id, candidate); },
  };
  const graph = createLearningAssistantGraph(deps);
  return { deps, graph, input, calls, events, persisted, memory, budget, loaded, toolNames };
}

describe('学习助手 LangGraph', () => {
  /** 普通编程允许直接回答，运行结束可复用且不泄露密钥。 */
  it('普通回复 END，同 run 重试不重复模型和消息', async () => {
    const f = fixture([json(MAIN)]);
    const first = await runLearningAssistant(f.graph, f.deps, f.input);
    const again = await runLearningAssistant(f.graph, f.deps, f.input);
    expect(first.response).toEqual(MAIN); expect(again.response).toEqual(MAIN);
    expect(f.calls).toHaveLength(1); expect(f.persisted.size).toBe(1);
    expect(JSON.stringify(first)).not.toContain('secret-not-in-checkpoint');
  });
  /** 主 Agent 可按顺序调用两个子 Agent，子工具使用可信身份并保持嵌套轨迹。 */
  it('串行归因→导师，子 Agent 可取数、加载 Skill，轨迹包含父工具', async () => {
    const parent = tool('analyze_wrong_answer', { task: '判断错因' }, 'attribution');
    parent.toolCalls = [...parent.toolCalls!, ...tool('generate_socratic_question', { task: '给一个问题' }, 'tutor').toolCalls!];
    const f = fixture([parent, tool('get_wrong_question'), json(ATTRIBUTION), tool('load_skill', { skill_id: 'misconception-repair' }), json(TUTOR), json({ ...MAIN, intent: 'socratic_followup', primary_question: TUTOR.primary_question, next_action: 'await_user', stage: 'waiting_for_user' })]);
    const result = await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.toolNames).toEqual(['get_wrong_question']); expect(f.loaded).toEqual(['misconception-repair']);
    expect(result.diagnosis).toEqual(ATTRIBUTION); expect(result.pendingQuestion).toBe(TUTOR.primary_question);
    expect(f.calls).toHaveLength(6);
    expect(f.calls[1]?.tools?.map((item) => item.name)).not.toContain('generate_socratic_question');
    const rootCall = f.events.find((event) => event.eventType === 'tool.started' && event.payload.toolName === 'analyze_wrong_answer');
    expect(f.events.some((event) => event.agentName === 'error_attribution' && event.parentSpanId === rootCall?.spanId && event.eventType === 'llm.request.started')).toBe(true);
    expect(f.events.some((event) => event.agentName === 'error_attribution' && event.payload.toolName === 'get_wrong_question')).toBe(true);
    expect(f.persisted.size).toBe(4); // 父 assistant 调用、两个 tool 结果、最终回复。
  });
  /** 子 Agent 即使伪造未暴露工具也不能继续委派。 */
  it('拒绝子 Agent 委派和模型指定身份', async () => {
    const f = fixture([tool('analyze_wrong_answer', { task: '归因' }), tool('generate_socratic_question', { task: '越权委派' }), tool('get_user_profile', { owner_id: randomUUID() }), json(ATTRIBUTION), json(MAIN)]);
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.toolNames).toEqual([]);
    const childInput = JSON.stringify(f.calls[3]?.messages);
    expect(childInput).toContain('TOOL_NOT_ALLOWED'); expect(childInput).toContain('TOOL_ARGUMENTS_INVALID');
  });
  /** 非法最终输出只修复一次且预算包含修复。 */
  it('主回复单问题校验和一次修复', async () => {
    const f = fixture([json({ ...MAIN, primary_question: '为什么？怎么改？' }), json(MAIN)]);
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.calls).toHaveLength(2); expect(f.calls[1]?.tools).toBeUndefined();
    expect(f.budget.get(f.input.run_id)).toBe(2);
    const bad = fixture([json({ bad: 1 }), json({ bad: 1 })]);
    await expect(runLearningAssistant(bad.graph, bad.deps, bad.input)).rejects.toThrow('一次修复后仍非法');
    expect(bad.calls).toHaveLength(2);
  });
  /** 子 Agent 不能伪造证据来源，修复后可回传 insufficient_evidence。 */
  it('校验子 Agent 证据并允许不足证据结论', async () => {
    const f = fixture([tool('analyze_wrong_answer', { task: '归因' }), json({ ...ATTRIBUTION, status: 'hypothesis', hypotheses: [{ error_type: 'boundary_case', explanation: '越界', confidence: 0.99, evidence_ids: ['invented'] }] }), json(ATTRIBUTION), json(MAIN)]);
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.calls[2]?.tools).toBeUndefined(); expect(f.memory.size).toBe(0);
  });
  /** 已保存父工具结果的恢复不重复执行工具和用户消息。 */
  it('模型节点失败后同 Checkpoint 恢复，复用取数结果', async () => {
    const f = fixture([tool('get_user_profile'), new Error('模拟网络崩溃'), json(MAIN)]);
    await expect(runLearningAssistant(f.graph, f.deps, f.input)).rejects.toThrow('模拟网络崩溃');
    expect(f.toolNames).toEqual(['get_user_profile']);
    const result = await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.toolNames).toEqual(['get_user_profile']); expect(result.messages.filter((item) => item.id === f.input.message.id)).toHaveLength(1);
    expect(f.budget.get(f.input.run_id)).toBe(3);
  });
  /** 持久化失败后恢复只重做持久化，不重新付费调用模型。 */
  it('回复写入失败后恢复，不重跑模型', async () => {
    const f = fixture([json(MAIN)]);
    const persist = f.deps.persistMessages;
    let first = true;
    f.deps.persistMessages = /** 首次写入故障后按固定 ID 重试。 */ async (run, messages) => { if (first) { first = false; throw new Error('模拟写库失败'); } await persist(run, messages); };
    await expect(runLearningAssistant(f.graph, f.deps, f.input)).rejects.toThrow('模拟写库失败');
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.calls).toHaveLength(1); expect(f.persisted.size).toBe(1);
  });

  /** 中间消息写入故障不能造成模型重发，或重复执行已经保存的取数工具。 */
  it('工具结果消息写入失败后恢复，只重试消息同步', async () => {
    const f = fixture([tool('get_user_profile'), json(MAIN)]);
    const persist = f.deps.persistMessages;
    let failed = false;
    f.deps.persistMessages = /** 首个工具结果同步时模拟故障。 */ async (run, messages) => {
      if (!failed && messages.some((message) => message.role === 'tool')) { failed = true; throw new Error('工具消息落库失败'); }
      await persist(run, messages);
    };
    await expect(runLearningAssistant(f.graph, f.deps, f.input)).rejects.toThrow('工具消息落库失败');
    expect(f.calls).toHaveLength(1); expect(f.toolNames).toEqual(['get_user_profile']);
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.calls).toHaveLength(2); expect(f.toolNames).toEqual(['get_user_profile']); expect(f.persisted.size).toBe(3);
  });

  /** Provider 在不同模型轮复用工具 ID 也不能覆盖较早的工具结果或轨迹 span。 */
  it('不同批次重复工具 ID 仍保持独立消息和轨迹', async () => {
    const f = fixture([tool('get_user_profile', {}, 'same'), tool('get_mastery_state', {}, 'same'), json(MAIN)]);
    await runLearningAssistant(f.graph, f.deps, f.input);
    const spans = f.events.filter((event) => event.eventType === 'tool.started').map((event) => event.spanId);
    expect(new Set(spans).size).toBe(2); expect(f.persisted.size).toBe(5);
  });
  /** 换 run 延续同会话，20 轮模型窗口包含当前，Checkpoint 保留历史。 */
  it('30 轮完整历史仍保存，模型仅接收最近20轮', async () => {
    const f = fixture([json(MAIN)]);
    const history: ConversationMessage[] = Array.from({ length: 29 }, (_, i) => [
      { id: randomUUID(), turnNo: i + 1, role: 'user' as const, content: '用户轮' + (i + 1) },
      { id: randomUUID(), turnNo: i + 1, role: 'assistant' as const, content: '回复轮' + (i + 1) },
    ]).flat();
    f.deps.loadInitialMessages = /** 提供完整冷启动历史。 */ async () => history;
    f.input.message.turn_no = 30;
    const result = await runLearningAssistant(f.graph, f.deps, f.input);
    const sent = f.calls[0]!.messages.slice(1);
    expect(sent).toHaveLength(39); expect(sent[0]?.content).toBe('用户轮11');
    expect(result.messages).toHaveLength(60); expect(result.messages.some((item) => item.content === '用户轮1')).toBe(true);
    const next = { ...f.input, run_id: randomUUID(), message: { id: randomUUID(), turn_no: 31, content: '下一轮' } };
    // 单独补模型响应，下一轮独立预算且保留前一轮状态。
    f.deps.model.complete = /** 下一轮合法输出。 */ async (request) => { await request.beforeModelAttempt?.(); f.calls.push(request); return { message: json(MAIN), usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' }; };
    const second = await runLearningAssistant(f.graph, f.deps, next);
    expect(second.messages).toHaveLength(62); expect(f.calls[1]?.messages[1]?.content).toBe('用户轮12');
  });
  /** 工具消息不会增加轮数，完整工具调用链不能被窗口截断。 */
  it('最近20轮保留本轮完整工具链', () => {
    const messages: ConversationMessage[] = [{ id: 'a', turnNo: 3, ...tool('get_user_profile', {}, 'c') }, { id: 'b', turnNo: 3, role: 'tool', toolCallId: 'c', name: 'get_user_profile', content: '{}' }];
    expect(recentModelMessages(messages, 3)).toHaveLength(2);
  });
  /** 运行最多20次，频繁工具循环仍由实际模型请求预算终止。 */
  it('第21次请求前停止，不给业务工具添加次数上限', async () => {
    const f = fixture(Array.from({ length: 21 }, () => tool('get_user_profile')));
    await expect(runLearningAssistant(f.graph, f.deps, f.input)).rejects.toThrow('20 次');
    expect(f.calls).toHaveLength(20); expect(f.toolNames).toHaveLength(20);
  });
  /** 结构字段可空；不允许在 explanation 偷塞另外的问题。 */
  it('主问题可空，解释里的额外问句不能通过', () => {
    expect(MainResponseSchema.safeParse(MAIN).success).toBe(true);
    expect(MainResponseSchema.safeParse({ ...MAIN, explanation: '懂了吗？', primary_question: '为什么？' }).success).toBe(false);
    expect(MainResponseSchema.safeParse({ ...MAIN, explanation: '字段 `name?: string` 可省略。\n```ts\nconst x = ok ? 1 : 0;\n```' }).success).toBe(true);
    expect(MainResponseSchema.safeParse({ ...MAIN, primary_question: '解释边界，同时说明如何修复' }).success).toBe(false);
  });

  /** 用户口头确认不写记忆；实际推演可写模型评估，但不能冒充代码执行验证。 */
  it('后续推演才允许记忆，未执行代码标为模型评估，写入保持幂等', async () => {
    const f = fixture([]);
    f.input.message.content = '最后一次下标等于长度，因此越界；改为 i < length。';
    let phase = 0;
    f.deps.model.complete = /** 返回委派、带当前用户证据的验证和主回复。 */ async (request) => {
      await request.beforeModelAttempt?.(); phase += 1;
      const message = phase === 1 ? tool('analyze_wrong_answer', { task: '验证推演' })
        : phase === 2 ? json({ ...ATTRIBUTION, verification: { status: 'verified', conclusion: '用户指出了越界条件', evidence_ids: [f.input.message.id], demonstrated_progress: true } }) : json(MAIN);
      return { message, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
    };
    await runLearningAssistant(f.graph, f.deps, f.input);
    const candidate = f.memory.get(f.input.run_id);
    expect(candidate?.evaluation).toBe('model_evaluated'); expect(candidate?.verification.status).toBe('model_evaluated');
    await runLearningAssistant(f.graph, f.deps, f.input);
    expect(f.memory.size).toBe(1); expect(phase).toBe(3);
    const ack = fixture([]);
    ack.input.message.content = '明白了';
    let ackPhase = 0;
    ack.deps.model.complete = /** 即使子模型自评已修复，口头确认仍不允许写记忆。 */ async (request) => {
      await request.beforeModelAttempt?.(); ackPhase += 1;
      const message = ackPhase === 1 ? tool('analyze_wrong_answer', { task: '验证' }) : ackPhase === 2
        ? json({ ...ATTRIBUTION, verification: { status: 'verified', conclusion: '自评已理解', evidence_ids: [ack.input.message.id], demonstrated_progress: true } }) : json(MAIN);
      return { message, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
    };
    await runLearningAssistant(ack.graph, ack.deps, ack.input);
    expect(ack.memory.size).toBe(0);
  });

  /** 保存待回答问题，连续两次无推进提高下一轮级别；换题重置诊断与待验证目标。 */
  it('连续两次未推进升级提示，换题重置', async () => {
    const f = fixture([]);
    const sentPrompts: string[] = [];
    f.deps.model.complete = /** 每轮保持一个主要问题。 */ async (request) => {
      await request.beforeModelAttempt?.(); sentPrompts.push(request.messages[0]?.content ?? '');
      return { message: json({ ...MAIN, primary_question: '最后一次下标是多少？', next_action: 'await_user', stage: 'waiting_for_user' }), usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
    };
    let current = f.input;
    await runLearningAssistant(f.graph, f.deps, current);
    for (let turn = 2; turn <= 3; turn += 1) {
      current = { ...current, run_id: randomUUID(), message: { id: randomUUID(), turn_no: turn, content: '不知道' } };
      await runLearningAssistant(f.graph, f.deps, current);
    }
    current = { ...current, run_id: randomUUID(), message: { id: randomUUID(), turn_no: 4, content: '再给点提示' } };
    const fourth = await runLearningAssistant(f.graph, f.deps, current);
    expect(fourth.hintLevel).toBe(1); expect(sentPrompts[3]).toContain('"hint_level":1');
    const changed = { ...current, run_id: randomUUID(), question_id: randomUUID(), message: { id: randomUUID(), turn_no: 5, content: '换一道题' } };
    const next = await runLearningAssistant(f.graph, f.deps, changed);
    expect(next.hintLevel).toBe(0); expect(next.diagnosis).toBeNull(); expect(next.verificationTarget).toBeNull();
    expect(sentPrompts[4]).toContain('"pending_question":null');
  });
});
