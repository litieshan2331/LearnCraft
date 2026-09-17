/**
 * 公网地址判定与 IP 文本解析。
 *
 * 职责：为受控模型出网提供“该地址是否属于公网”的判定。Python 使用 ipaddress.is_global，
 * Node 没有等价物，因此这里自建拒绝表，并显式处理两类容易被绕过的形式：
 * IPv4-mapped IPv6（::ffff:0:0/96）与 NAT64（64:ff9b::/96）——它们的内层都是 IPv4，必须先解包再判断。
 *
 * 导出：
 * - ParsedAddress：解析结果（地址族与 128 位无符号数值）。
 * - parseIpv4 / parseIpv6 / parseAddress：把地址文本解析为数值，非法返回 null。
 * - isIpLiteral：判断文本是否为 IP 字面量（用于拒绝用户把 base_url 写成 IP）。
 * - isPublicAddress：仅当地址属于公网可路由范围时返回 true。
 */

export type AddressFamily = 4 | 6;

export interface ParsedAddress {
  family: AddressFamily;
  /** IPv4 使用低 32 位；IPv6 使用低 128 位。 */
  value: bigint;
}

const IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // link-local，含云元数据 169.254.169.254
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 中继任播
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4] // 保留，含 255.255.255.255
];

const IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // 未指定
  ['::1', 128], // 环回
  ['64:ff9b::', 96], // NAT64（内层为 IPv4）
  ['64:ff9b:1::', 48], // 本地用途 NAT64
  ['100::', 64], // 丢弃前缀
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // 基准测试
  ['2001:10::', 28], // ORCHID
  ['2001:db8::', 32], // 文档
  ['2002::', 16], // 6to4
  ['3fff::', 20], // 文档（RFC 9637）
  ['5f00::', 16], // SRv6
  ['fc00::', 7], // 唯一本地地址
  ['fe80::', 10], // link-local
  ['ff00::', 8] // 组播
];

const IPV4_MAPPED_PREFIX = '::ffff:0:0';
const NAT64_PREFIX = '64:ff9b::';
const GLOBAL_UNICAST_PREFIX = '2000::';

/** 把点分十进制 IPv4 解析为 32 位数值；非法或多余前导零返回 null。 */
export function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** 把 IPv6 文本解析为 128 位数值；支持 :: 压缩与内嵌 IPv4。 */
export function parseIpv6(text: string): bigint | null {
  if (text.length === 0 || text.includes('%')) {
    return null;
  }
  const doubleColonCount = text.split('::').length - 1;
  if (doubleColonCount > 1) {
    return null;
  }
  const [head, tail] = doubleColonCount === 1 ? text.split('::') : [text, null];
  const parseGroups = (segment: string): number[] | null => {
    if (segment.length === 0) {
      return [];
    }
    const groups: number[] = [];
    for (const rawGroup of segment.split(':')) {
      if (rawGroup.includes('.')) {
        const embedded = parseIpv4(rawGroup);
        if (embedded === null) {
          return null;
        }
        groups.push(Number((embedded >> 16n) & 0xffffn), Number(embedded & 0xffffn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(rawGroup)) {
        return null;
      }
      groups.push(parseInt(rawGroup, 16));
    }
    return groups;
  };
  const headGroups = parseGroups(head ?? '');
  const tailGroups = tail === null ? [] : parseGroups(tail);
  if (headGroups === null || tailGroups === null) {
    return null;
  }
  const total = headGroups.length + tailGroups.length;
  if (doubleColonCount === 0 ? total !== 8 : total > 7) {
    return null;
  }
  const groups = [...headGroups, ...new Array<number>(8 - total).fill(0), ...tailGroups];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

/** 统一解析入口；无法解析为 IP 时返回 null。 */
export function parseAddress(text: string): ParsedAddress | null {
  const ipv4 = parseIpv4(text);
  if (ipv4 !== null) {
    return { family: 4, value: ipv4 };
  }
  const ipv6 = parseIpv6(text);
  if (ipv6 !== null) {
    return { family: 6, value: ipv6 };
  }
  return null;
}

/** 判断文本是否为 IP 字面量（IPv4 或 IPv6 文本形式）。 */
export function isIpLiteral(text: string): boolean {
  const trimmed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return parseAddress(trimmed) !== null;
}

function toBigInt(value: string): bigint {
  const parsed = parseAddress(value);
  if (parsed === null) {
    throw new Error(`内部错误：无法解析内置地址 ${value}`);
  }
  return parsed.family === 4 ? parsed.value : parsed.value;
}

function ipv4PrefixOf(value: string): bigint {
  const parsed = parseIpv4(value);
  if (parsed === null) {
    throw new Error(`内部错误：无法解析内置地址 ${value}`);
  }
  return parsed;
}

function inPrefix(value: bigint, prefix: bigint, bits: number, width: 32 | 128): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === prefix >> shift;
}

function isPublicIpv4(value: bigint): boolean {
  return !IPV4_RANGES.some(([prefix, bits]) => inPrefix(value, ipv4PrefixOf(prefix), bits, 32));
}

function isPublicIpv6(value: bigint): boolean {
  const mappedPrefix = toBigInt(IPV4_MAPPED_PREFIX);
  if (inPrefix(value, mappedPrefix, 96, 128)) {
    // IPv4-mapped：解包低 32 位后按 IPv4 规则判断，否则 ::ffff:10.0.0.1 会被当成普通 IPv6 放行。
    return isPublicIpv4(value & 0xffffffffn);
  }
  const nat64Prefix = toBigInt(NAT64_PREFIX);
  if (inPrefix(value, nat64Prefix, 96, 128)) {
    // NAT64：同理，内层嵌的是 IPv4。
    return isPublicIpv4(value & 0xffffffffn);
  }
  if (IPV6_RANGES.some(([prefix, bits]) => inPrefix(value, toBigInt(prefix), bits, 128))) {
    return false;
  }
  return inPrefix(value, toBigInt(GLOBAL_UNICAST_PREFIX), 3, 128);
}

/** 仅当地址属于公网可路由范围时返回 true；无法解析一律返回 false。 */
export function isPublicAddress(text: string): boolean {
  const trimmed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const parsed = parseAddress(trimmed);
  if (parsed === null) {
    return false;
  }
  return parsed.family === 4 ? isPublicIpv4(parsed.value) : isPublicIpv6(parsed.value);
}
