/**
 * 学习节点完成标记服务的基础设施装配入口。
 *
 * 导出：
 * - getNodeCompletionService：复用 Web 进程中的完成标记服务实例。
 */

import { NodeCompletionService } from "../application/node-completion-service";
import { DrizzleNodeCompletionRepository } from "./drizzle-node-completion-repository";

let nodeCompletionService: NodeCompletionService | undefined;

export function getNodeCompletionService(): NodeCompletionService {
  nodeCompletionService ??= new NodeCompletionService(new DrizzleNodeCompletionRepository());
  return nodeCompletionService;
}