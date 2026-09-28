/**
 * 最小 RESP 客户端：只实现配额计数需要的命令子集，避免为三条命令引入额外依赖。
 *
 * 职责：按 redis:// URL（含可选密码与 db 号）建立连接，顺序执行命令并解析
 * 简单字符串、错误、整数与批量字符串四种回复；连接或协议错误抛出 RespRedisError，
 * 调用方据此把「配额不可用」与「额度用尽」区分开（与 Python 的 fail-closed 行为一致）。
 *
 * 尚未实现的回复类型（数组、嵌套）会抛出明确的错误，不会静默返回错误结果。
 *
 * 导出：
 * - RespRedisError：连接、超时与协议错误。
 * - RespRedisClient：按 URL 连接的最小 Redis 命令客户端。
 * - parseRedisUrl：解析 redis:// 连接串（供测试与排障使用）。
 */

import net from 'node:net';

export class RespRedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespRedisError';
  }
}

export interface RedisUrlParts {
  host: string;
  port: number;
  password: string | null;
  username: string | null;
  database: number;
}

/** 解析 redis:// 连接串；不支持的协议或缺少主机时抛错。 */
export function parseRedisUrl(url: string): RedisUrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RespRedisError('Redis 连接串不是合法 URL。');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RespRedisError('只支持 redis:// 与 rediss:// 连接串。');
  }
  if (parsed.protocol === 'rediss:') {
    throw new RespRedisError('暂不支持 TLS 连接串。');
  }
  const host = parsed.hostname;
  if (host.length === 0) {
    throw new RespRedisError('Redis 连接串缺少主机名。');
  }
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 6379;
  const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : null;
  const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : null;
  const databasePath = parsed.pathname.replace(/^\//, '');
  const database = databasePath.length > 0 ? Number.parseInt(databasePath, 10) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new RespRedisError('Redis 连接串的 db 号不合法。');
  }
  return { host, port, password, username, database };
}

function encodeCommand(args: readonly string[]): Buffer {
  const parts: string[] = ['*' + String(args.length) + '\r\n'];
  for (const arg of args) {
    const bytes = Buffer.from(arg, 'utf8');
    parts.push('$' + String(bytes.length) + '\r\n');
    parts.push(arg);
    parts.push('\r\n');
  }
  return Buffer.from(parts.join(''), 'utf8');
}

export class RespRedisClient {
  private readonly parts: RedisUrlParts;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private commandTail: Promise<void> = Promise.resolve();

  constructor(options: { url: string; connectTimeoutMs?: number; commandTimeoutMs?: number }) {
    this.parts = parseRedisUrl(options.url);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2_000;
  }

  /** 执行一条命令；失败时抛 RespRedisError，调用方负责降级。 */
  async command(...args: string[]): Promise<string | number | null> {
    let release: () => void = () => undefined;
    const previous = this.commandTail;
    this.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.commandInternal(args);
    } finally {
      release();
    }
  }

  /** 在串行队列中执行 Redis 命令，避免共享 RESP 缓冲区被并发请求交叉读写。 */
  private async commandInternal(args: readonly string[]): Promise<string | number | null> {
    await this.ensureConnected();
    const socket = this.socket;
    if (socket === null) {
      throw new RespRedisError('Redis 连接不可用。');
    }
    this.buffer = Buffer.alloc(0);
    await this.write(socket, encodeCommand(args));
    return this.readReply(socket, Date.now() + this.commandTimeoutMs);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket !== null) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket !== null && this.ready && !this.socket.destroyed) {
      return;
    }
    await this.close();

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection({ host: this.parts.host, port: this.parts.port });
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new RespRedisError('Redis 连接超时。'));
      }, this.connectTimeoutMs);
      candidate.once('connect', () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once('error', (error) => {
        clearTimeout(timer);
        candidate.destroy();
        reject(new RespRedisError('Redis 连接失败：' + error.message));
      });
    });

    socket.on('error', () => {
      // 连接不可用时置位，下一条命令会重新建立连接。
      this.ready = false;
    });
    this.socket = socket;

    try {
      if (this.parts.password !== null) {
        const authArgs = this.parts.username !== null
          ? ['AUTH', this.parts.username, this.parts.password]
          : ['AUTH', this.parts.password];
        const authReply = await this.commandOn(socket, authArgs);
        if (typeof authReply === 'string' && authReply.toUpperCase() !== 'OK') {
          throw new RespRedisError('Redis 认证失败。');
        }
      }
      if (this.parts.database !== 0) {
        await this.commandOn(socket, ['SELECT', String(this.parts.database)]);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
    this.ready = true;
  }

  private async commandOn(socket: net.Socket, args: readonly string[]): Promise<string | number | null> {
    this.buffer = Buffer.alloc(0);
    await this.write(socket, encodeCommand(args));
    return this.readReply(socket, Date.now() + this.commandTimeoutMs);
  }

  private write(socket: net.Socket, payload: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      socket.write(payload, (error) => {
        if (error) {
          reject(new RespRedisError('Redis 写入失败：' + error.message));
          return;
        }
        resolve();
      });
    });
  }

  private readReply(socket: net.Socket, deadline: number): Promise<string | number | null> {
    return new Promise<string | number | null>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new RespRedisError('Redis 命令超时。')), Math.max(1, deadline - Date.now()));

      const finish = (error: RespRedisError | null, value?: string | number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(value ?? null);
      };

      const tryParse = (): void => {
        const parsed = parseReply(this.buffer);
        if (parsed === null) {
          if (this.buffer.length > 1_048_576) {
            finish(new RespRedisError('Redis 回复超出预期长度。'));
          }
          return;
        }
        this.buffer = this.buffer.subarray(parsed.consumed);
        if (parsed.error !== null) {
          finish(new RespRedisError('Redis 命令失败：' + parsed.error));
          return;
        }
        finish(null, parsed.value);
      };

      const onData = (chunk: Buffer): void => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        tryParse();
      };
      const onError = (error: Error): void => {
        this.ready = false;
        finish(new RespRedisError('Redis 连接错误：' + error.message));
      };
      const onClose = (): void => {
        this.ready = false;
        finish(new RespRedisError('Redis 连接已关闭。'));
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      tryParse();
    });
  }
}

interface ParsedReply {
  consumed: number;
  value: string | number | null;
  error: string | null;
}

/** 解析一条完整回复；数据不完整时返回 null。只支持 +、-、:、$ 四种类型。 */
function parseReply(buffer: Buffer): ParsedReply | null {
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0) {
    return null;
  }
  const marker = String.fromCharCode(buffer[0] ?? 0);
  const line = buffer.subarray(1, lineEnd).toString('utf8');

  if (marker === '+') {
    return { consumed: lineEnd + 2, value: line, error: null };
  }
  if (marker === '-') {
    return { consumed: lineEnd + 2, value: null, error: line };
  }
  if (marker === ':') {
    return { consumed: lineEnd + 2, value: Number.parseInt(line, 10), error: null };
  }
  if (marker === '$') {
    const length = Number.parseInt(line, 10);
    if (Number.isNaN(length)) {
      return { consumed: lineEnd + 2, value: null, error: '批量字符串长度不合法。' };
    }
    if (length < 0) {
      return { consumed: lineEnd + 2, value: null, error: null };
    }
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) {
      return null;
    }
    return { consumed: end + 2, value: buffer.subarray(start, end).toString('utf8'), error: null };
  }
  return { consumed: lineEnd + 2, value: null, error: '暂不支持的 Redis 回复类型：' + marker };
}
