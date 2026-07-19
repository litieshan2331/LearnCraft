/**
 * Web 版本信息 Route Handler。
 *
 * 函数：
 * - GET：返回可安全公开的 Web 服务版本与 Git 提交标识，不暴露环境变量或密钥。
 */

import { getWebServiceStatus } from "@/lib/system/service-status";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(getWebServiceStatus());
}
