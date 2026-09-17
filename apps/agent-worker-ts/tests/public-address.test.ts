/**
 * 公网地址判定的单元测试。
 *
 * 覆盖：公网 IPv4/IPv6 放行、私网与保留段拒绝，以及两类必须解包后再判断的绕过形式
 * （IPv4-mapped IPv6 与 NAT64）。这些用例是 SSRF 防护的回归基线。
 */
import { describe, expect, it } from 'vitest';

import { isIpLiteral, isPublicAddress, parseAddress } from '../src/infrastructure/llm/public-address.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('放行公网地址 %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '100.64.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ])('拒绝私网或保留 IPv4 %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1'])(
    '拒绝私网或保留 IPv6 %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it('解包 IPv4-mapped IPv6 后再判断（::ffff:10.0.0.1 必须拒绝）', () => {
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('解包 NAT64 后再判断（64:ff9b::a00:1 即 10.0.0.1，必须拒绝）', () => {
    expect(isPublicAddress('64:ff9b::a00:1')).toBe(false);
    expect(isPublicAddress('64:ff9b::808:808')).toBe(true);
  });
});

describe('parseAddress 与 isIpLiteral', () => {
  it('解析 IPv4 与 IPv6 文本', () => {
    expect(parseAddress('8.8.8.8')).toEqual({ family: 4, value: 0x08080808n });
    expect(parseAddress('::1')).toEqual({ family: 6, value: 1n });
    expect(parseAddress('不是地址')).toBeNull();
  });

  it('识别带方括号的 IPv6 字面量', () => {
    expect(isIpLiteral('8.8.8.8')).toBe(true);
    expect(isIpLiteral('[2606:4700:4700::1111]')).toBe(true);
    expect(isIpLiteral('2130706433')).toBe(false);
    expect(isIpLiteral('api.example.com')).toBe(false);
  });
});
