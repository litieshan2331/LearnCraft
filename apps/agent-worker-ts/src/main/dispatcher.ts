/**
 * Dispatcher 进程入口。
 *
 * 职责：装配数据库连接池、BullMQ 队列与 OutboxDispatcher，并在收到 SIGTERM/SIGINT 时优雅关闭：
 * 停止领取新事件 → 释放已领取但未发布的事件 → 关闭队列与连接池 → 退出。
 *
 * 运行时路由由 AGENT_RUNTIME_ROUTES 控制：只有映射为 ts 的 run_type 会被本进程领取；
 * 映射为空表示不领取任何事件（用于回滚到 Python 运行时）。
 */

import pg from 'pg';

import { readAgentQueueConfig, readOutboxDispatcherConfig } from '../bootstrap/config.js';
import { closeAgentQueue, createAgentQueue, createBullMqPublisher } from '../infrastructure/queue/bullmq-agent-queue.js';
import { OutboxDispatcher } from '../infrastructure/queue/outbox-dispatcher.js';

async function main(): Promise<void> {
  const dispatcherConfig = readOutboxDispatcherConfig();
  const queueConfig = readAgentQueueConfig();

  const pool = new pg.Pool({ connectionString: dispatcherConfig.databaseUrl, max: 4 });
  const queue = createAgentQueue(queueConfig);
  const dispatcher = new OutboxDispatcher(pool, createBullMqPublisher(queue, queueConfig), dispatcherConfig);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[dispatcher] 收到 ' + signal + '，开始优雅关闭');
    await dispatcher.stop();
    await closeAgentQueue(queue);
    await pool.end();
    console.log('[dispatcher] 已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    '[dispatcher] 启动：id=' + dispatcherConfig.dispatcherId +
      '，队列=' + dispatcherConfig.queueName +
      '，前缀=' + dispatcherConfig.queuePrefix +
      '，负责的 run_type=' + JSON.stringify(dispatcherConfig.runTypes),
  );
  await dispatcher.run();
}

main().catch((error: unknown) => {
  console.error('[dispatcher] 启动失败', error);
  process.exit(1);
});
