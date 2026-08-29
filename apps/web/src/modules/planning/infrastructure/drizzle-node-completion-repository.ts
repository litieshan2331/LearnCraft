/**
 * 学习节点完成标记的 Drizzle 适配器。
 *
 * 导出：
 * - DrizzleNodeCompletionRepository：按所有者将节点状态记录为 completed。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { planNodes } from "@/lib/db/schema";

import type { NodeCompletionRepository } from "../domain/node-completion";

export class DrizzleNodeCompletionRepository implements NodeCompletionRepository {
  async markCompleted(ownerId: string, planNodeId: string): Promise<boolean> {
    const database = getDatabase();
    const updated = await database
      .update(planNodes)
      .set({
        status: "completed",
        updatedAt: new Date(),
      })
      .where(and(
        eq(planNodes.id, planNodeId),
        eq(planNodes.ownerId, ownerId),
      ))
      .returning({ id: planNodes.id });

    return updated.length > 0;
  }
}