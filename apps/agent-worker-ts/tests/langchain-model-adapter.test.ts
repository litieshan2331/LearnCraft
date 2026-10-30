/**
 * 学习助手 LangChain ChatModel 适配器测试。
 * 调用顺序：构造假 ModelPort → 绑定 LangChain 工具 → 转换消息和工具 → 断言网关请求及 AIMessage。
 */
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelCompletionRequest } from '../src/infrastructure/llm/model-gateway.js';
import { LearningAssistantChatModel } from '../src/workflows/learning-assistant/agents/langchain-model-adapter.js';

describe('LearningAssistantChatModel', () => {
  it('把 LangChain 工具和消息转换为现有网关合同', async () => {
    let request: ModelCompletionRequest | undefined;
    const model = new LearningAssistantChatModel({
      async complete(value) {
        request = value;
        return { message: { role: 'assistant', content: '已读取' }, usage: { inputTokens: 2, outputTokens: 3 }, finishReason: 'stop' };
      },
    }, {
      agentRunId: 'run',
      connection: { ownerId: 'owner', connectionId: 'connection', modelId: 'model', baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    });
    const getProfile = tool(async () => 'profile', { name: 'get_user_profile', description: '读取画像', schema: z.object({}) });
    const result = await model.bindTools([getProfile]).invoke([new HumanMessage('读取画像')]);
    expect(request?.messages).toEqual([{ role: 'user', content: '读取画像' }]);
    expect(request?.tools?.[0]).toMatchObject({ name: 'get_user_profile', description: '读取画像' });
    expect(result.content).toBe('已读取');
  });

  it('把网关工具调用转换为 AIMessage tool_calls', async () => {
    const model = new LearningAssistantChatModel({
      async complete() {
        return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'get_user_profile', argumentsJson: '{}' }] }, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'tool_calls' };
      },
    }, {
      agentRunId: 'run',
      connection: { ownerId: 'owner', connectionId: 'connection', modelId: 'model', baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    });
    const result = await model.invoke([new HumanMessage('读取画像')]);
    expect(result.tool_calls).toEqual([{ id: 'call-1', name: 'get_user_profile', args: {} }]);
    const repeated = await model.invoke([new HumanMessage('再次读取画像')]);
    expect(repeated.tool_calls?.[0]?.id).toBe(result.tool_calls?.[0]?.id);
    expect(result.usage_metadata).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it('向 Provider 回传工具结果时保留原始 tool_call_id', async () => {
    const requests: ModelCompletionRequest[] = [];
    const model = new LearningAssistantChatModel({
      async complete(request) {
        requests.push(request);
        const message = requests.length === 1
          ? { role: 'assistant' as const, content: null, toolCalls: [{ id: 'call_provider_123', name: 'get_user_profile', argumentsJson: '{}' }] }
          : { role: 'assistant' as const, content: '已读取画像' };
        return { message, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: requests.length === 1 ? 'tool_calls' : 'stop' };
      },
    }, {
      agentRunId: 'run',
      connection: { ownerId: 'owner', connectionId: 'connection', modelId: 'model', baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    });
    const user = new HumanMessage('读取画像');
    const call = await model.invoke([user]);
    const callId = call.tool_calls?.[0]?.id;
    if (!callId) throw new Error('测试模型未生成工具调用 ID');
    const toolResult = new ToolMessage({ content: '画像结果', tool_call_id: callId, name: 'get_user_profile' });
    await model.invoke([user, call, toolResult]);

    expect(requests[1]?.messages.slice(1)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_provider_123', name: 'get_user_profile', argumentsJson: '{}' }] },
      { role: 'tool', content: '画像结果', toolCallId: 'call_provider_123', name: 'get_user_profile' },
    ]);
  });

  it('拒绝缺少 tool_call_id 的模型工具调用', async () => {
    const model = new LearningAssistantChatModel({
      async complete() {
        return { message: { role: 'assistant', content: null, toolCalls: [{ id: '', name: 'get_user_profile', argumentsJson: '{}' }] }, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'tool_calls' };
      },
    }, {
      agentRunId: 'run',
      connection: { ownerId: 'owner', connectionId: 'connection', modelId: 'model', baseUrl: 'https://example.invalid', apiKey: 'test-only' },
    });
    await expect(model.invoke([new HumanMessage('读取画像')])).rejects.toThrow('模型工具调用缺少 tool_call_id');
  });

  it('透传已有网关的预算、轨迹和用量，不创建第二条模型调用路径', async () => {
    let request: ModelCompletionRequest | undefined;
    const beforeModelAttempt = async () => undefined;
    const traceWriter = { async append() {} };
    const model = new LearningAssistantChatModel({
      async complete(value) {
        request = value;
        await value.beforeModelAttempt?.();
        return { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 4, outputTokens: 2 }, finishReason: 'stop' };
      },
    }, {
      agentRunId: 'run',
      connection: { ownerId: 'owner', connectionId: 'connection', modelId: 'model', baseUrl: 'https://example.invalid', apiKey: 'test-only' },
      beforeModelAttempt,
      traceWriter,
    });
    const result = await model.invoke([new HumanMessage('hi')]);
    expect(request?.beforeModelAttempt).toBe(beforeModelAttempt);
    expect(request?.traceWriter).toBe(traceWriter);
    expect(result.usage_metadata).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  });
});

