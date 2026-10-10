# 学习助手持久化模块

当前实现会话、消息、对话运行和学习经历记忆四个领域端口，共用 `DrizzleLearningAssistantRepository`，通过 `getLearningAssistantRepository()` 装配。数据库沿用 Web 的 `getDatabase()` 共享连接池；本阶段未接入 HTTP API、队列、Agent 图或前端。

## 调用顺序

1. `createConversation` 创建会话，允许目标和来源错题为空；非空引用必须属于当前用户。
2. `createQueuedRun` 在同一事务中保存用户消息、分配 `turn_no` 和创建 `queued` 运行；同一会话和幂等键重试返回已有记录，内容改变则报冲突。
3. `startOwnedRun` 领取运行；仅 `started: true` 的调用者可执行。重复领取不再次执行，失败恢复的队列策略将在后续任务中接入。
4. `appendRunMessages` 保存助手和工具消息；`updateRunningRun` 写入累计统计快照，不重复增加计数。
5. `finishOwnedRun` 原子保存最终消息、运行终态、统计和会话阶段。相同结果可重试，已结束运行不接受新消息。
6. `recordLearningMemory` 保存有来源证据的经历。证据必须引用当前会话的用户消息或当前用户的测评作答，来源运行必须属于同一会话。修复判定由应用层与 Agent 提供，本模块不根据模型猜测更新用户画像。

## 消息与上下文

全部消息按 `sequence_no` 连续保存。`listOwnedMessages` 提供历史游标分页；`getRecentContext` 固定读取最近 20 个 `turn_no` 内的全部消息，包含当前尚未回复的用户轮次，不截断该轮工具调用链，也不删除更早的消息。

同一会话仅允许一个 `queued` 或 `running` 运行，所有写入以会话行锁串行化。关闭会话前须结束当前运行。助手消息、工具消息和学习经历的 `id` 必须在首次请求前生成，重试时复用；不得每次重试重新生成。

学习经历没有用户直接修改或删除端口，`findOwnedMemories` 仅供服务端工具获取长期经历。所有 Repository 调用须由服务端提供经过认证的 `ownerId`，模型不能自行指定用户身份。

## 验证

数据库集成测试仅在显式设置 `LEARNING_ASSISTANT_TEST_DATABASE_URL` 时运行；默认测试流程跳过。测试创建随机用户及会话，结束后清理这些测试数据，不改动已有业务记录。

在 Web 目录下使用本地 `infra/.env` 开发数据库执行：

```powershell
node --env-file=../../infra/.env --input-type=module -e 'process.env.LEARNING_ASSISTANT_TEST_DATABASE_URL = process.env.DATABASE_URL; process.argv = [process.argv[0], "vitest", "run", "tests/integration/learning-assistant-repository.test.ts"]; await import("./node_modules/vitest/vitest.mjs");'
```
