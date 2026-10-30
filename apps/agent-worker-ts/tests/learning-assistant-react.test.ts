/**
 * 学习助手 LangChain ReAct 委派测试。
 * 调用顺序：装配可恢复图与假模型 → 主 Agent 委派或处理工具错误 → 子 Agent 自然语言响应 → 持久化主回复。
 */
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { ModelCompletionRequest, ModelMessage } from '../src/infrastructure/llm/model-gateway.js';
import { ModelGatewayError } from '../src/infrastructure/llm/model-gateway.js';
import { createLearningAssistantGraph, runLearningAssistant } from '../src/workflows/learning-assistant/graph.js';
import type { LearningAssistantDependencies } from '../src/workflows/learning-assistant/ports.js';
import type { RunInput } from '../src/workflows/learning-assistant/schemas/index.js';
import { assertControlState, serializeAssistantState, type ConversationMessage } from '../src/workflows/learning-assistant/state.js';

function fixture(childFails = false, readToolFirst = false) {
  const input: RunInput = {
    run_id: randomUUID(), conversation_id: randomUUID(), owner_id: randomUUID(), connection_id: randomUUID(), model_id: 'test-model',
    question_id: null, message: { id: randomUUID(), turn_no: 1, content: '请分析这个错误' },
  };
  const calls: ModelCompletionRequest[] = [];
  const saved: ConversationMessage[] = [];
  let reads = 0;
  let mainTurn = 0;
  const deps: LearningAssistantDependencies = {
    checkpointer: new MemorySaver(),
    connection: { ownerId: input.owner_id, connectionId: input.connection_id, modelId: input.model_id, baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    trace: { async append() {} },
    async reserveModelAttempt() { return calls.length + 1; },
    reactLimits: { main: 5, error_attribution: 3, socratic_tutor: 3 },
    skills: { listSkills: () => [], loadSkill: () => '只提出一个问题' },
    tavily: { async execute() { return { ok: true, code: 'OK', message: '', data: {} }; } },
    async readBusinessTool(name) { reads += 1; return { data: { name }, evidence: [] }; },
    async loadInitialMessages() { return []; },
    async persistMessages(_run, messages) { saved.push(...messages); },
    model: {
      async complete(request) {
        calls.push(request);
        const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
        if (system.includes('你是错题归因子 Agent')) {
          if (childFails) throw new ModelGatewayError('TEST_CHILD_UNAVAILABLE', '内部敏感细节', true);
          return { message: { role: 'assistant', content: '错误来自循环边界判断，当前证据不足以确认是否已修正。' }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
        }
        mainTurn += 1;
        if (mainTurn === 1) return { message: { role: 'assistant', content: null, toolCalls: [readToolFirst
          ? { id: 'read-1', name: 'get_user_profile', argumentsJson: '{}' }
          : { id: 'delegate-1', name: 'analyze_wrong_answer', argumentsJson: JSON.stringify({ task: '分析错误来源' }) }] }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_calls' };
        return { message: { role: 'assistant', content: childFails ? '子分析暂时不可用，我先根据已有信息给出初步建议。' : '循环条件应保证下标小于数组长度。' }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
      },
    },
  };
  return { input, calls, saved, graph: createLearningAssistantGraph(deps), deps, get reads() { return reads; } };
}

describe('学习助手 LangChain ReAct 委派', () => {
  it('主 Agent 通过委派工具调用自然语言子 Agent，并在父 State 保存结果', async () => {
    const value = fixture();
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(result.responseText).toContain('循环条件');
    expect(result.diagnosisText).toContain('错误来自循环边界');
    expect(value.calls).toHaveLength(3);
    expect(value.saved.at(-1)).toMatchObject({ role: 'assistant', content: result.responseText });
    expect(value.calls[1]?.tools?.map((item) => item.name)).not.toContain('analyze_wrong_answer');
    expect(value.calls[1]?.tools?.map((item) => item.name)).not.toContain('generate_socratic_question');
    const serialized = serializeAssistantState(result);
    expect(JSON.parse(serialized)).toMatchObject({ stateVersion: 3, responseText: result.responseText });
    expect(serialized).not.toContain('test-only');
  });

  it('子 Agent 失败作为工具错误返回主 Agent，由主 Agent 自行降级且不伪造子结果', async () => {
    const value = fixture(true);
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(result.responseText).toContain('子分析暂时不可用');
    expect(result.diagnosisText).toBeNull();
    const error = JSON.stringify(value.calls.map((call) => call.messages));
    expect(error).toContain('子 Agent error_attribution');
    expect(error).not.toContain('内部敏感细节');
    expect(value.calls[2]?.messages.some((message) => message.role === 'tool' && message.content?.includes('TEST_CHILD_UNAVAILABLE'))).toBe(true);
  });

  it('拒绝未知 Checkpoint 版本和越界服务端控制状态', async () => {
    const value = fixture();
    const config = { configurable: { thread_id: value.input.conversation_id } };
    await value.graph.updateState(config, { stateVersion: 999, input: value.input });
    await expect(runLearningAssistant(value.graph, value.deps, value.input)).rejects.toThrow('Checkpoint 版本不受支持');
    expect(() => assertControlState({ intent: null, stage: 'new', hintLevel: 4, stalledTurns: 0, pendingQuestion: null, verificationTarget: null })).toThrow('提示级别越界');
  });

  it('Checkpoint 恢复时不重放已完成工具或模型调用，消息 ID 保持幂等', async () => {
    const value = fixture(false, true);
    const persistMessages = value.deps.persistMessages;
    let failOnce = true;
    value.deps.persistMessages = async (input, messages) => {
      if (failOnce) { failOnce = false; throw new Error('模拟业务消息写入中断'); }
      await persistMessages(input, messages);
    };
    await expect(runLearningAssistant(value.graph, value.deps, value.input)).rejects.toThrow('模拟业务消息写入中断');
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(value.calls).toHaveLength(2);
    expect(value.reads).toBe(1);
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(new Set(value.saved.map((message) => message.id)).size).toBe(value.saved.length);
  });
});
