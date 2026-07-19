/**
 * Web 健康检查 Route Handler。
 *
 * 函数：
 * - GET：返回 Web 进程和基础运行时的健康状态；数据库就绪检查将在基础设施接入后补充。
 */

import { getWebServiceStatus } from "@/lib/system/service-status";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(getWebServiceStatus());
}
