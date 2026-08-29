/**
 * 学习节点完成标记应用服务。
 *
 * 导出：
 * - NodeCompletionService：只记录当前用户的完成状态，不检查前置章节或内容状态。
 */

import {
  NodeCompletionServiceError,
  type NodeCompletionRepository,
  type NodeCompletionRequest,
} from "../domain/node-completion";

export class NodeCompletionService {
  constructor(private readonly repository: NodeCompletionRepository) {}

  async markCompleted(input: NodeCompletionRequest): Promise<void> {
    const updated = await this.repository.markCompleted(input.ownerId, input.planNodeId);
    if (!updated) {
      throw new NodeCompletionServiceError("PLAN_NODE_NOT_FOUND");
    }
  }
}