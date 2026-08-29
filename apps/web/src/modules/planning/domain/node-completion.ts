/**
 * 学习节点完成标记用例的领域契约。
 *
 * 导出：
 * - NodeCompletionRequest：用户标记节点完成的输入。
 * - NodeCompletionRepository：按所有者更新节点完成状态的持久化端口。
 * - NodeCompletionServiceError：完成标记稳定错误。
 */

export interface NodeCompletionRequest {
  ownerId: string;
  planNodeId: string;
}

export interface NodeCompletionRepository {
  markCompleted(ownerId: string, planNodeId: string): Promise<boolean>;
}

export type NodeCompletionServiceErrorCode = "PLAN_NODE_NOT_FOUND";

export class NodeCompletionServiceError extends Error {
  constructor(public readonly code: NodeCompletionServiceErrorCode) {
    super(code);
    this.name = "NodeCompletionServiceError";
  }
}