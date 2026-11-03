/**
 * 学习助手 Agent 共用的稳定标识、轨迹和限流错误工具。
 * 调用顺序：LangChain runner 生成稳定 ID → 写入嵌套轨迹或消息 → 达到服务端上限时抛出稳定错误。
 */
import { createHash } from 'node:crypto';
import { ModelGatewayError } from '../../../infrastructure/llm/model-gateway.js';
import type { TraceWriter } from '../../../application/services/trace-writer.js';
import type { LearningAssistantDependencies } from '../ports.js';
import type { Actor } from '../schemas/index.js';

/** 生成稳定 UUID，用于工具调用、消息幂等和父子轨迹关联。 */
export function stableId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** 生成角色级 ReAct 上限错误；上限来自服务端装配，模型和用户不能修改。 */
export function reactLimitExceeded(actor: Actor, limit: number): ModelGatewayError {
  return new ModelGatewayError('LEARNING_ASSISTANT_REACT_LIMIT_EXCEEDED', '学习助手 Agent ' + actor + ' 已达到本次运行的 ReAct 轮数上限 ' + String(limit) + '。', false);
}

/** 为 Agent 模型请求提供嵌套轨迹父子关系，连接密钥不进入轨迹。 */
export function scopedTrace(deps: LearningAssistantDependencies, actor: Actor, spanId: string, parentSpanId: string | null): TraceWriter {
  return { async append(event) { await deps.trace.append({ ...event, spanId, parentSpanId, agentName: actor }); } };
}

/** 保留旧调用方可识别的预算错误构造器。 */
export function modelBudgetExceeded(): ModelGatewayError {
  return new ModelGatewayError('LEARNING_ASSISTANT_MODEL_BUDGET_EXCEEDED', '模型请求预算已用完。', false);
}
