/**
 * 学习计划查询服务的基础设施装配入口。
 *
 * 导出：
 * - getPlanQueryService：复用 Web 进程中的计划查询服务实例。
 */

import { PlanQueryService } from "../application/plan-query-service";
import { DrizzlePlanQueryRepository } from "./drizzle-plan-query-repository";

let planQueryService: PlanQueryService | undefined;

export function getPlanQueryService(): PlanQueryService {
  planQueryService ??= new PlanQueryService(new DrizzlePlanQueryRepository());
  return planQueryService;
}