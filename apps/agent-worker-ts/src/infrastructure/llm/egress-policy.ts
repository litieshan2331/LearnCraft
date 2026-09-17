/**
 * 模型受控出网的地址与 URL 策略（等价于 Python 的 ModelEgressPolicy）。
 *
 * 职责：把用户填写的 Base URL 收敛为“可安全连接的公网端点”，或给出稳定错误码。
 * 规则：仅 https；端口仅 443；禁止 userinfo/query/fragment 与相对路径段；禁止 IP 字面量、纯数字域名与
 * localhost/.local；每次调用重新解析全部 DNS，且**任一**结果不是公网地址就整体拒绝；连接目标取解析结果
 * 中的第一个地址（消除校验与连接之间的 TOCTOU）。
 *
 * 导出：
 * - ModelEgressPolicyError：带稳定错误码的策略异常。
 * - AsyncDnsResolver / SystemDnsResolver：可注入的解析器接口与默认实现。
 * - ResolvedEndpoint：策略通过后的端点（含被钉死的 IP）。
 * - ModelEgressPolicy：resolveEndpoint 与静态 buildPinnedRequestUrl。
 * - MODEL_EGRESS_* 错误码常量。
 */

import { lookup } from 'node:dns/promises';
import { isIpLiteral, isPublicAddress } from './public-address.js';

export const MODEL_EGRESS_INVALID_URL = 'MODEL_EGRESS_INVALID_URL';
export const MODEL_EGRESS_INVALID_URL_PATH = 'MODEL_EGRESS_INVALID_URL_PATH';
export const MODEL_EGRESS_INVALID_HOST = 'MODEL_EGRESS_INVALID_HOST';
export const MODEL_EGRESS_LITERAL_IP_FORBIDDEN = 'MODEL_EGRESS_LITERAL_IP_FORBIDDEN';
export const MODEL_EGRESS_LOCAL_HOST_FORBIDDEN = 'MODEL_EGRESS_LOCAL_HOST_FORBIDDEN';
export const MODEL_EGRESS_DNS_RESOLUTION_FAILED = 'MODEL_EGRESS_DNS_RESOLUTION_FAILED';
export const MODEL_EGRESS_DNS_RESOLUTION_EMPTY = 'MODEL_EGRESS_DNS_RESOLUTION_EMPTY';
export const MODEL_EGRESS_DNS_INVALID_RESULT = 'MODEL_EGRESS_DNS_INVALID_RESULT';
export const MODEL_EGRESS_PRIVATE_IP_FORBIDDEN = 'MODEL_EGRESS_PRIVATE_IP_FORBIDDEN';
export const MODEL_EGRESS_INVALID_ENDPOINT = 'MODEL_EGRESS_INVALID_ENDPOINT';

export class ModelEgressPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelEgressPolicyError';
  }
}

export interface AsyncDnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

/** 默认解析器：不做跨请求缓存，保证每次调用都重新解析（与 Python 实现一致）。 */
export class SystemDnsResolver implements AsyncDnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  }
}

export interface ResolvedEndpoint {
  baseUrl: string;
  hostname: string;
  port: number;
  pinnedIp: string;
}

function isDigitOnlyHostname(hostname: string): boolean {
  const withoutDots = hostname.replaceAll('.', '');
  return withoutDots.length > 0 && /^\d+$/.test(withoutDots);
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === 'local' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  );
}

/** 出网策略端口：仅暴露 resolveEndpoint，便于测试注入固定端点。 */
export interface EgressEndpointPolicy {
  resolveEndpoint(baseUrl: string): Promise<ResolvedEndpoint>;
}

export class ModelEgressPolicy implements EgressEndpointPolicy {
  constructor(private readonly resolver: AsyncDnsResolver = new SystemDnsResolver()) {}

  /** 校验并解析 Base URL，返回含钉死 IP 的端点；任一步失败抛出 ModelEgressPolicyError。 */
  async resolveEndpoint(baseUrl: string): Promise<ResolvedEndpoint> {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL, '模型 Base URL 不是合法的绝对地址。');
    }
    if (parsed.protocol !== 'https:') {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL, '模型 Base URL 必须使用 https。');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL, '模型 Base URL 不能包含账号或密码。');
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL, '模型 Base URL 不能包含查询参数或片段。');
    }
    if (parsed.port !== '' && parsed.port !== '443') {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL, '模型 Base URL 只允许 443 端口。');
    }
    // 注意：URL 的 hostname 已按 UTS#46（punycode）归一化，Python 使用 IDNA2003，边界域名结果可能不同。
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname.length === 0) {
      throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_HOST, '模型 Base URL 缺少主机名。');
    }
    this.ensureRawPathHasNoRelativeSegments(baseUrl);
    const segments = this.parsePathSegments(parsed.pathname);
    // 注意：WHATWG URL 会把整数/八进制形式的主机名（如 2130706433、0177.0.0.1）归一化为 127.0.0.1，
    // 因此这类输入会命中 LITERAL_IP_FORBIDDEN 而不是 Python 的 LOCAL_HOST_FORBIDDEN。两者都拒绝请求，
    // 安全性质一致，但错误码不同，排障与告警规则需按“拒绝类错误码”聚合而不是精确匹配单个码。
    if (isIpLiteral(hostname)) {
      throw new ModelEgressPolicyError(MODEL_EGRESS_LITERAL_IP_FORBIDDEN, '模型 Base URL 不能使用 IP 字面量。');
    }
    if (isDigitOnlyHostname(hostname) || isLocalHostname(hostname)) {
      throw new ModelEgressPolicyError(MODEL_EGRESS_LOCAL_HOST_FORBIDDEN, '模型 Base URL 不能指向本机或本地域名。');
    }
    const answers = await this.resolveAll(hostname);
    const pinnedIp = this.ensureEveryAddressIsPublic(answers);
    const path = segments.length === 0 ? '' : '/' + segments.join('/');
    return { baseUrl: 'https://' + hostname + path, hostname, port: 443, pinnedIp };
  }

  /**
   * 在归一化之前检查原始 URL 的路径段。
   * 注意：WHATWG URL 会在解析阶段把 /v1/../admin 直接归一化成 /admin，因此若只检查 parsed.pathname，
   * Python 侧的 MODEL_EGRESS_INVALID_URL_PATH 将永远不触发，行为不再等价。
   */
  private ensureRawPathHasNoRelativeSegments(baseUrl: string): void {
    const authorityEnd = baseUrl.indexOf('://');
    const pathStart = authorityEnd === -1 ? -1 : baseUrl.indexOf('/', authorityEnd + 3);
    if (pathStart === -1) {
      return;
    }
    let rawPath = baseUrl.slice(pathStart);
    const queryStart = rawPath.search(/[?#]/);
    if (queryStart !== -1) {
      rawPath = rawPath.slice(0, queryStart);
    }
    for (const rawSegment of rawPath.split('/')) {
      if (rawSegment.length === 0) {
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawSegment);
      } catch {
        throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL_PATH, '模型 Base URL 的路径段无法解码。');
      }
      if (decoded === '.' || decoded === '..') {
        throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL_PATH, '模型 Base URL 不能包含相对路径段。');
      }
    }
  }

  private parsePathSegments(pathname: string): string[] {
    const segments: string[] = [];
    for (const rawSegment of pathname.split('/')) {
      if (rawSegment.length === 0) {
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawSegment);
      } catch {
        throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL_PATH, '模型 Base URL 的路径段无法解码。');
      }
      if (decoded === '.' || decoded === '..') {
        throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_URL_PATH, '模型 Base URL 不能包含相对路径段。');
      }
      segments.push(decoded);
    }
    return segments;
  }

  private async resolveAll(hostname: string): Promise<string[]> {
    let answers: string[];
    try {
      answers = await this.resolver.resolve(hostname);
    } catch {
      throw new ModelEgressPolicyError(MODEL_EGRESS_DNS_RESOLUTION_FAILED, '模型 Base URL 的域名解析失败。');
    }
    const deduplicated = [...new Set(answers)];
    if (deduplicated.length === 0) {
      throw new ModelEgressPolicyError(MODEL_EGRESS_DNS_RESOLUTION_EMPTY, '模型 Base URL 的域名没有解析结果。');
    }
    return deduplicated;
  }

  /** 任一解析结果不是合法公网地址就整体拒绝；返回第一个地址用于连接。 */
  private ensureEveryAddressIsPublic(addresses: readonly string[]): string {
    for (const address of addresses) {
      if (!isIpLiteral(address)) {
        throw new ModelEgressPolicyError(MODEL_EGRESS_DNS_INVALID_RESULT, '模型域名解析返回了非法地址。');
      }
      if (!isPublicAddress(address)) {
        throw new ModelEgressPolicyError(MODEL_EGRESS_PRIVATE_IP_FORBIDDEN, '模型域名解析到了非公网地址。');
      }
    }
    const first = addresses[0];
    if (first === undefined) {
      throw new ModelEgressPolicyError(MODEL_EGRESS_DNS_RESOLUTION_EMPTY, '模型 Base URL 的域名没有解析结果。');
    }
    return first;
  }

  /** 构造“URL host 即钉死 IP”的请求地址（等价于 Python 的 _build_pinned_request_url）。 */
  static buildPinnedRequestUrl(endpoint: ResolvedEndpoint, endpointSegments: readonly string[]): string {
    for (const segment of endpointSegments) {
      if (segment.length === 0 || segment.includes('/') || segment === '.' || segment === '..') {
        throw new ModelEgressPolicyError(MODEL_EGRESS_INVALID_ENDPOINT, '模型请求路径段非法。');
      }
    }
    const host = endpoint.pinnedIp.includes(':') ? '[' + endpoint.pinnedIp + ']' : endpoint.pinnedIp;
    const port = endpoint.port === 443 ? '' : ':' + String(endpoint.port);
    const basePath = new URL(endpoint.baseUrl).pathname.replace(/\/$/, '');
    const suffix = endpointSegments.length === 0 ? '' : '/' + endpointSegments.join('/');
    return 'https://' + host + port + basePath + suffix;
  }
}
