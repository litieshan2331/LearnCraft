/**
 * Web 服务状态构造器。
 *
 * 类型：
 * - ServiceStatusResponse：与 OpenAPI `ServiceStatusResponse` 对齐的公开响应数据。
 *
 * 函数：
 * - getWebServiceStatus：读取安全的运行时版本信息并构造 Web 服务状态响应。
 * - readEnvironmentValue：读取非空环境变量，避免将空字符串写入公开响应。
 */

export type ServiceStatusResponse = Readonly<{
  status: "ok" | "degraded";
  service: "web";
  version: string;
  git_sha: string;
}>;

const DEFAULT_VERSION = "0.1.0";
const DEFAULT_GIT_SHA = "unknown";

function readEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function getWebServiceStatus(): ServiceStatusResponse {
  return {
    status: "ok",
    service: "web",
    version:
      readEnvironmentValue("APP_VERSION") ??
      readEnvironmentValue("npm_package_version") ??
      DEFAULT_VERSION,
    git_sha: readEnvironmentValue("GIT_SHA") ?? DEFAULT_GIT_SHA,
  };
}
