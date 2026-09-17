# main：进程入口

| 文件 | 职责 |
| --- | --- |
| `dispatcher.ts` | 装配连接池、BullMQ 队列与 `OutboxDispatcher`；收到 SIGTERM/SIGINT 时停止领取、释放未投递事件、关闭资源后退出 |
| `worker.ts` | 装配内部接口客户端、凭据解密器、受控出网客户端、模型网关与工作流注册表，启动 BullMQ 消费端；关闭时等待在飞任务结束（不强杀，未完成任务由锁与 stalled 检测重投） |

运行依赖的环境变量见上级目录 README 的「进程与环境变量」。
