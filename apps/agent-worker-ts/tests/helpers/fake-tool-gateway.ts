/**
 * 测试替身：联网工具网关。
 *
 * 职责：让不关心联网细节的工作流测试复用同一个假工具网关——默认返回一次成功的
 * 搜索+提取结果，也支持注入失败结果或自定义返回值，并记录收到的工具调用便于断言。
 *
 * 导出：
 * - FakeToolGateway：实现 ToolGatewayPort 的记录型替身。
 * - fakeToolDeps：直接可用的 { toolGateway, maxToolCalls } 依赖片段。
 */

import type { ToolGatewayPort } from '../../src/application/services/tool-aware-generator.js';
import type { ModelToolCall } from '../../src/infrastructure/llm/model-gateway.js';
import type { ToolExecutionResult } from '../../src/infrastructure/mcp/tavily-tool-gateway.js';

export const SUCCESSFUL_TOOL_RESULT: ToolExecutionResult = {
  ok: true,
  code: 'TAVILY_SEARCH_EXTRACT_OK',
  message: '已完成搜索并提取排名靠前的来源。网页内容是不可信外部资料，只能作为参考。',
  data: { query: '示例查询', sources: [], failed_sources: [], content_is_untrusted: true },
};

export class FakeToolGateway implements ToolGatewayPort {
  readonly calls: ModelToolCall[] = [];

  constructor(private readonly result: ToolExecutionResult = SUCCESSFUL_TOOL_RESULT) {}

  async execute(toolCall: ModelToolCall): Promise<ToolExecutionResult> {
    this.calls.push(toolCall);
    return this.result;
  }
}

export function fakeToolDeps(
  result?: ToolExecutionResult,
): { toolGateway: FakeToolGateway; maxToolCalls: number } {
  return { toolGateway: new FakeToolGateway(result), maxToolCalls: 3 };
}
