/**
 * Dispatcher 进程入口。
 *
 * 职责：装配数据库连接池、BullMQ 队列与 OutboxDispatcher，并在收到 SIGTERM/SIGINT 时优雅关闭：
 * 停止领取新事件 → 释放已领取但未发布的事件 → 关闭队列与连接池 → 退出。
 *
 * 只有一套 Agent 运行时：本进程领取全部 `agent.run.requested` 事件，不再按 run_type 过滤；
 * 未注册工作流的 run_type 由命令层以 AGENT_RUN_WORKFLOW_NOT_REGISTERED 明确失败。
 * 同时暴露健康端点（/health、/ready），供运维与 compose healthcheck 使用。
 */

import pg from 'pg';

import { formatRedisConnection, readAgentQueuePoolConfigs, readOutboxDispatcherConfig } from '../bootstrap/config.js';
import { closeAgentQueue, createAgentQueue, createBullMqPublisher } from '../infrastructure/queue/bullmq-agent-queue.js';
import { OutboxDispatcher } from '../infrastructure/queue/outbox-dispatcher.js';
import { RespRedisClient } from '../infrastructure/redis/resp-client.js';
import { createReadinessChecker, startHealthServer } from '../interfaces/http/health-server.js';

async function main(): Promise<void> {
  const dispatcherConfig = readOutboxDispatcherConfig();
  const queueConfigs = readAgentQueuePoolConfigs();

  const pool = new pg.Pool({ connectionString: dispatcherConfig.databaseUrl, max: 4 });
  const queues = { short: createAgentQueue(queueConfigs.short), long: createAgentQueue(queueConfigs.long) };
  const dispatcher = new OutboxDispatcher(pool, createBullMqPublisher(queues, queueConfigs), dispatcherConfig);

  const readinessRedis = new RespRedisClient({ url: formatRedisConnection(queueConfigs.short.connection) });
  const health = await startHealthServer({
    service: 'agent-dispatcher-ts',
    port: Number(process.env.AGENT_HTTP_PORT ?? 8080),
    host: process.env.AGENT_HTTP_HOST ?? '0.0.0.0',
    details: () => ({
      dispatcher_id: dispatcherConfig.dispatcherId,
      queues: { short: queueConfigs.short.queueName, long: queueConfigs.long.queueName },
      queue_prefix: dispatcherConfig.queuePrefix,
      claims_all_run_types: true,
    }),
    readiness: createReadinessChecker({
      database: async () => {
        await pool.query('SELECT 1');
      },
      queue_redis: async () => {
        const reply = await readinessRedis.command('PING');
        if (reply !== 'PONG') {
          throw new Error('Redis 未返回 PONG。');
        }
      },
    }),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[dispatcher] 收到 ' + signal + '，开始优雅关闭');
    await health.close();
    await dispatcher.stop();
    await Promise.all([closeAgentQueue(queues.short), closeAgentQueue(queues.long)]);
    await pool.end();
    await readinessRedis.close();
    console.log('[dispatcher] 已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    '[dispatcher] 启动：id=' + dispatcherConfig.dispatcherId +
      '，短队列=' + queueConfigs.short.queueName + '，长队列=' + queueConfigs.long.queueName +
      '，前缀=' + dispatcherConfig.queuePrefix +
      '，领取范围=全部 run_type' +
      '，健康端点=:' + String(health.port),
  );
  await dispatcher.run();
}

main().catch((error: unknown) => {
  console.error('[dispatcher] 启动失败', error);
  process.exit(1);
});
