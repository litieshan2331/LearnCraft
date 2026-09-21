/**
 * AgentRun 进度发布器的测试（使用本地假 Redis，不依赖真实服务）。
 *
 * 重点固化：
 * - 频道命名与 web 侧订阅规则一致；
 * - 事件结构（协议版本、运行内序号、参数字符串截断）；
 * - 发布失败只告警、绝不抛出（进度通道故障不得影响 AgentRun）。
 */
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  AGENT_PROGRESS_CHANNEL_PREFIX,
  RedisAgentProgressPublisher,
  agentProgressChannel,
} from '../src/infrastructure/redis/agent-progress-publisher.js';
import type { AgentProgressEvent } from '../src/application/services/agent-progress.js';

/** 解析一条 RESP 数组命令；数据不足时返回 null。 */
function readCommand(input: string): { args: string[]; rest: string } | null {
  if (!input.startsWith('*')) {
    return null;
  }
  const lines = input.split('\r\n');
  const header = lines[0];
  if (header === undefined) {
    return null;
  }
  const count = Number(header.slice(1));
  if (!Number.isInteger(count) || count <= 0) {
    return null;
  }
  const args: string[] = [];
  let index = 1;
  for (let position = 0; position < count; position += 1) {
    const lengthLine = lines[index];
    const value = lines[index + 1];
    if (lengthLine === undefined || !lengthLine.startsWith('$') || value === undefined) {
      return null;
    }
    if (Buffer.byteLength(value, 'utf8') !== Number(lengthLine.slice(1))) {
      return null;
    }
    args.push(value);
    index += 2;
  }
  return { args, rest: lines.slice(index).join('\r\n') };
}

/** 最小假 Redis：解析命令并统一回复整数 0，便于捕获 PUBLISH。 */
async function startFakeRedis(): Promise<{
  port: number;
  commands: string[][];
  close: () => Promise<void>;
}> {
  const commands: string[][] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const parsed = readCommand(buffer);
        if (parsed === null) {
          break;
        }
        buffer = parsed.rest;
        commands.push(parsed.args);
        socket.write(':0\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    commands,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('频道命名', () => {
  it('与 web 侧订阅前缀保持一致，且只由 runId 派生', () => {
    expect(AGENT_PROGRESS_CHANNEL_PREFIX).toBe('learncraft:agent-progress:');
    expect(agentProgressChannel('11111111-2222-4333-8444-555555555555'))
      .toBe('learncraft:agent-progress:11111111-2222-4333-8444-555555555555');
  });
});

describe('RedisAgentProgressPublisher', () => {
  it('按频道发布事件，序号递增，字符串参数按上限截断', async () => {
    const server = await startFakeRedis();
    const publisher = new RedisAgentProgressPublisher({
      url: 'redis://127.0.0.1:' + String(server.port),
    });
    const reporter = publisher.createReporter('11111111-2222-4333-8444-555555555555');

    try {
      reporter.report('run.preparing');
      reporter.report('tool.called', { query: 'x'.repeat(300), turn: 1 });
      await publisher.close();

      expect(server.commands).toHaveLength(2);
      const [first, second] = server.commands;
      expect(first?.[0]).toBe('PUBLISH');
      expect(first?.[1]).toBe('learncraft:agent-progress:11111111-2222-4333-8444-555555555555');

      const firstEvent = JSON.parse(String(first?.[2])) as AgentProgressEvent;
      expect(firstEvent).toMatchObject({ v: 1, step: 'run.preparing', seq: 1 });
      expect(typeof firstEvent.at).toBe('string');

      const secondEvent = JSON.parse(String(second?.[2])) as AgentProgressEvent;
      expect(secondEvent.step).toBe('tool.called');
      expect(secondEvent.seq).toBe(2);
      expect(secondEvent.data?.turn).toBe(1);
      // 默认上限 200：超长检索词被截断，不进入通道。
      expect(String(secondEvent.data?.query)).toHaveLength(200);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('发布失败只告警，不抛出（进度通道故障不影响 AgentRun）', async () => {
    const errors: unknown[] = [];
    const publisher = new RedisAgentProgressPublisher({
      url: 'redis://127.0.0.1:1',
      commandTimeoutMs: 500,
      onError: (error) => errors.push(error),
    });

    expect(() => publisher.createReporter('run-1').report('run.preparing')).not.toThrow();
    await publisher.close();
    expect(errors.length).toBeGreaterThan(0);
  }, 20_000);
});
