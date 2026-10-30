/**
 * 学习助手新运行合同验收。
 * 调用顺序：装配 LangGraph 与假网关 → 执行 LangChain ReAct → 检查自由文本、State 和幂等消息。
 */
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { ModelCompletionRequest, ModelMessage } from '../src/infrastructure/llm/model-gateway.js';
import { createLearningAssistantGraph, runLearningAssistant } from '../src/workflows/learning-assistant/graph.js';
import type { LearningAssistantDependencies } from '../src/workflows/learning-assistant/ports.js';
import type { RunInput } from '../src/workflows/learning-assistant/schemas/index.js';
import { serializeAssistantState, type ConversationMessage } from '../src/workflows/learning-assistant/state.js';

function tool(name: string, id: string): ModelMessage {
  const args = name === 'analyze_wrong_answer' || name === 'generate_socratic_question' ? { task: '处理当前学习问题' } : {};
  return { role: 'assistant', content: null, toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] };
}

function fixture(script: ModelMessage[]) {
  const input: RunInput = {
    run_id: randomUUID(), conversation_id: randomUUID(), owner_id: randomUUID(), connection_id: randomUUID(), model_id: 'test-model',
    question_id: null, message: { id: randomUUID(), turn_no: 1, content: '请解释这个边界条件' },
  };
  const calls: ModelCompletionRequest[] = [];
  const persisted = new Map<string, ConversationMessage>();
  const toolsUsed: string[] = [];
  const deps: LearningAssistantDependencies = {
    checkpointer: new MemorySaver(),
    connection: { ownerId: input.owner_id, connectionId: input.connection_id, modelId: input.model_id, baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    reactLimits: { main: 6, error_attribution: 4, socratic_tutor: 4 },
    trace: { async append() {} },
    async reserveModelAttempt() { return calls.length + 1; },
    model: {
      async complete(request) {
        await request.beforeModelAttempt?.();
        calls.push(request);
        const message = script.shift();
        if (message === undefined) throw new Error('测试模型响应耗尽');
        return { message, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
      },
    },
    skills: { listSkills: () => [], loadSkill: () => '' },
    tavily: { async execute() { return { ok: false, code: 'DAILY_LIMIT', message: '配额耗尽', data: {} }; } },
    async readBusinessTool(name) { toolsUsed.push(name); return { data: { name }, evidence: [] }; },
    async loadInitialMessages() { return []; },
    async persistMessages(_run, messages) { for (const message of messages) persisted.set(message.id, message); },
  };
  return { input, calls, persisted, toolsUsed, deps, graph: createLearningAssistantGraph(deps) };
}

describe('学习助手新 LangChain/LangGraph 合同', () => {
  it('自由文本和 Markdown 原样保存，不解析或修复 JSON', async () => {
    const reply = '结论如下：`index < items.length`。\n\n```ts\nreturn items[index];\n```';
    const value = fixture([{ role: 'assistant', content: reply }]);
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(result.responseText).toBe(reply);
    expect([...value.persisted.values()].some((message) => message.role === 'assistant' && message.content === reply)).toBe(true);
    expect(result.pendingQuestion).toBeNull();
  });

  it('看似 JSON 的自然语言也直接作为 responseText 保存', async () => {
    const reply = '{"explanation":"这不是结构化输出合同"}';
    const value = fixture([{ role: 'assistant', content: reply }]);
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(result.responseText).toBe(reply);
  });

  it('重复工具调用 ID 在不同模型轮次仍产生独立消息并保留原 ID', async () => {
    const value = fixture([tool('get_user_profile', 'same'), tool('get_mastery_state', 'same'), { role: 'assistant', content: '已读取两项服务端事实。' }]);
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(value.toolsUsed).toEqual(['get_user_profile', 'get_mastery_state']);
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
    const toolMessages = result.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(['same', 'same']);
    expect(new Set(toolMessages.map((message) => message.id)).size).toBe(2);
  });

  it('控制状态独立于自然语言，并可安全序列化恢复', async () => {
    const value = fixture([{ role: 'assistant', content: '我可以继续说明边界。' }]);
    const result = await runLearningAssistant(value.graph, value.deps, value.input);
    const serialized = serializeAssistantState(result);
    expect(JSON.parse(serialized)).toMatchObject({ stateVersion: 4, responseText: '我可以继续说明边界。', pendingQuestion: null, hintLevel: 0 });
    expect(serialized).not.toContain('test-only');
  });

  it('不从自然语言推断待回答问题，提示升级仅由服务端 State 推进', async () => {
    const question = '请推演最后一次循环的下标。';
    const value = fixture([
      tool('generate_socratic_question', 'delegate-1'),
      { role: 'assistant', content: question },
      { role: 'assistant', content: '先观察循环条件。' },
      { role: 'assistant', content: '我们继续分析。' },
      { role: 'assistant', content: '请重新检查边界。' },
      { role: 'assistant', content: '提示等级已由 State 更新。' },
      { role: 'assistant', content: '换题后重新开始。' },
    ]);
    const first = await runLearningAssistant(value.graph, value.deps, value.input);
    expect(first.pendingQuestion).toBeNull();
    await value.graph.updateState({ configurable: { thread_id: value.input.conversation_id } }, { pendingQuestion: question, stalledTurns: 0 });
    let input = { ...value.input, run_id: randomUUID(), message: { id: randomUUID(), turn_no: 2, content: '我不确定' } };
    await runLearningAssistant(value.graph, value.deps, input);
    input = { ...input, run_id: randomUUID(), message: { id: randomUUID(), turn_no: 3, content: '还是不确定' } };
    const escalated = await runLearningAssistant(value.graph, value.deps, input);
    expect(escalated.hintLevel).toBe(1);
    expect(value.calls.at(-1)?.messages[0]?.content).toContain('"hint_level":1');
    input = { ...input, run_id: randomUUID(), question_id: randomUUID(), message: { id: randomUUID(), turn_no: 4, content: '换一道题' } };
    const changed = await runLearningAssistant(value.graph, value.deps, input);
    expect(changed.hintLevel).toBe(0);
    expect(changed.pendingQuestion).toBeNull();
  });
});
