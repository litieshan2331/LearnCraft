/**
 * 出网策略的单元测试，断言与 Python 侧 tests/unit/test_model_egress_policy.py 对齐。
 *
 * 覆盖：公网端点解析与首个 IP 钉死、非 https/非 443/userinfo/相对路径段拒绝、IP 字面量与本地域名拒绝、
 * DNS 结果中任一私网地址即整体拒绝、钉死 URL 构造，以及请求路径段校验。
 */
import { describe, expect, it } from 'vitest';

import {
  MODEL_EGRESS_DNS_RESOLUTION_EMPTY,
  MODEL_EGRESS_DNS_RESOLUTION_FAILED,
  MODEL_EGRESS_INVALID_ENDPOINT,
  MODEL_EGRESS_INVALID_URL,
  MODEL_EGRESS_INVALID_URL_PATH,
  MODEL_EGRESS_LITERAL_IP_FORBIDDEN,
  MODEL_EGRESS_LOCAL_HOST_FORBIDDEN,
  MODEL_EGRESS_PRIVATE_IP_FORBIDDEN,
  ModelEgressPolicy,
  ModelEgressPolicyError,
  type AsyncDnsResolver,
  type ResolvedEndpoint,
} from '../src/infrastructure/llm/egress-policy.js';

class FakeResolver implements AsyncDnsResolver {
  readonly calls: string[] = [];

  constructor(private readonly answers: string[] | Error) {}

  async resolve(hostname: string): Promise<string[]> {
    this.calls.push(hostname);
    if (this.answers instanceof Error) {
      throw this.answers;
    }
    return this.answers;
  }
}

async function expectPolicyError(baseUrl: string, answers: string[] | Error, code: string): Promise<void> {
  const resolver = new FakeResolver(answers);
  const policy = new ModelEgressPolicy(resolver);
  await expect(policy.resolveEndpoint(baseUrl)).rejects.toMatchObject({ code });
}

describe('ModelEgressPolicy.resolveEndpoint', () => {
  it('规范化主机名并钉死解析结果中的第一个公网 IP', async () => {
    const resolver = new FakeResolver(['8.8.8.8', '1.1.1.1']);
    const policy = new ModelEgressPolicy(resolver);

    const endpoint = await policy.resolveEndpoint('https://API.Example.com:443/v1/');

    expect(resolver.calls).toEqual(['api.example.com']);
    expect(endpoint).toEqual({
      baseUrl: 'https://api.example.com/v1',
      hostname: 'api.example.com',
      port: 443,
      pinnedIp: '8.8.8.8',
    });
  });

  it.each([
    ['http://api.example.com', MODEL_EGRESS_INVALID_URL],
    ['https://api.example.com:8443/v1', MODEL_EGRESS_INVALID_URL],
    ['https://user:pass@api.example.com/v1', MODEL_EGRESS_INVALID_URL],
    ['https://api.example.com/v1?token=1', MODEL_EGRESS_INVALID_URL],
    ['https://8.8.8.8', MODEL_EGRESS_LITERAL_IP_FORBIDDEN],
    ['https://[2606:4700:4700::1111]', MODEL_EGRESS_LITERAL_IP_FORBIDDEN],
    ['https://localhost/v1', MODEL_EGRESS_LOCAL_HOST_FORBIDDEN],
    ['https://api.local/v1', MODEL_EGRESS_LOCAL_HOST_FORBIDDEN],
    // 整数形式主机名会被 WHATWG URL 归一化为 127.0.0.1，因此报字面量 IP 码；两者都拒绝。
    ['https://2130706433/v1', MODEL_EGRESS_LITERAL_IP_FORBIDDEN],
    ['https://api.example.com/v1/../admin', MODEL_EGRESS_INVALID_URL_PATH],
    ['https://api.example.com/v1/%2e%2e/admin', MODEL_EGRESS_INVALID_URL_PATH],
  ])('拒绝非法 Base URL：%s', async (baseUrl, code) => {
    await expectPolicyError(baseUrl, ['8.8.8.8'], code);
  });

  it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254', '100.64.0.1', '::1', '::ffff:10.0.0.1'])(
    'DNS 结果中出现非公网地址 %s 时整体拒绝',
    async (address) => {
      await expectPolicyError('https://api.example.com/v1', ['8.8.8.8', address], MODEL_EGRESS_PRIVATE_IP_FORBIDDEN);
    },
  );

  it('DNS 解析失败与空结果分别报稳定错误码', async () => {
    await expectPolicyError('https://api.example.com/v1', new Error('ENOTFOUND'), MODEL_EGRESS_DNS_RESOLUTION_FAILED);
    await expectPolicyError('https://api.example.com/v1', [], MODEL_EGRESS_DNS_RESOLUTION_EMPTY);
  });
});

describe('ModelEgressPolicy.buildPinnedRequestUrl', () => {
  const endpoint: ResolvedEndpoint = {
    baseUrl: 'https://api.example.com/v1',
    hostname: 'api.example.com',
    port: 443,
    pinnedIp: '8.8.8.8',
  };

  it('URL 的 host 是钉死 IP，且不含域名', () => {
    expect(ModelEgressPolicy.buildPinnedRequestUrl(endpoint, ['chat', 'completions'])).toBe(
      'https://8.8.8.8/v1/chat/completions',
    );
  });

  it('IPv6 钉死地址使用方括号', () => {
    const ipv6Endpoint: ResolvedEndpoint = { ...endpoint, pinnedIp: '2606:4700:4700::1111' };
    expect(ModelEgressPolicy.buildPinnedRequestUrl(ipv6Endpoint, ['chat', 'completions'])).toBe(
      'https://[2606:4700:4700::1111]/v1/chat/completions',
    );
  });

  it('拒绝非法请求路径段', () => {
    expect(() => ModelEgressPolicy.buildPinnedRequestUrl(endpoint, ['..'])).toThrow(ModelEgressPolicyError);
    expect(() => ModelEgressPolicy.buildPinnedRequestUrl(endpoint, ['a/b'])).toThrow(/路径段非法/);
    expect(() => ModelEgressPolicy.buildPinnedRequestUrl(endpoint, [''])).toThrow(ModelEgressPolicyError);
    try {
      ModelEgressPolicy.buildPinnedRequestUrl(endpoint, ['']);
    } catch (error) {
      expect(error).toMatchObject({ code: MODEL_EGRESS_INVALID_ENDPOINT });
    }
  });
});
