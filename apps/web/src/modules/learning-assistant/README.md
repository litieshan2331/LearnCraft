# 学习助手持久化模块

当前实现会话、消息和对话运行三个领域端口，共用 `DrizzleLearningAssistantRepository`，通过 `getLearningAssistantRepository()` 装配。学习助手旧长期记忆运行链路已退役；数据库表和历史迁移暂时保留，存量处理待确认。应用服务由 `getLearningAssistantService()` 装配，HTTP API 负责公开会话和运行状态生命周期；Worker 通过下方内部接口执行上下文读取和结果回写。

## Worker 内部接口

以下接口只接受 `x-learncraft-internal-secret`，不使用浏览器 Session，也不接受 Worker/模型传入的用户身份：

- `GET /internal/v1/learning-assistant-runs/{run_id}/context`：按运行反查用户和会话，返回最近 20 轮消息、现有测评错题、用户画像和最近掌握度摘要；不查询长期记忆。
- `POST /internal/v1/learning-assistant-runs/{run_id}/messages`：幂等保存助手与工具消息。
- `POST /internal/v1/learning-assistant-runs/{run_id}/result`：幂等回写模型统计、会话状态、成功/失败终态和安全错误摘要。

这些接口的原始模型和工具轨迹不进入公开消息响应，轨迹由 Agent Worker 的独立观测表保存。

## 当前 API

- `GET /api/v1/learning-assistant/conversations`：读取当前用户的会话列表，默认 50 条、上限 200 条。
- `POST /api/v1/learning-assistant/conversations`：创建会话，`goal_id` 和 `source_assessment_answer_id` 可为空。
- `GET /api/v1/learning-assistant/conversations/{conversation_id}`：读取会话详情、`active_run_id` 和教学状态快照 `stage`、`pending_question`、`hint_level`，便于页面刷新后继续查询在途状态和恢复教学状态。
- `GET /api/v1/learning-assistant/conversations/{conversation_id}/messages`：按 `after_sequence_no` 和 `limit` 游标分页读取全部消息，默认和上限均为 100 条，返回 `next_after_sequence_no`。
- `POST /api/v1/learning-assistant/conversations/{conversation_id}/messages`：使用 `Idempotency-Key` 保存用户消息并创建 `queued` 运行，返回 `202`；此请求不直接调用模型。
- `GET /api/v1/learning-assistant/runs/{run_id}`：读取运行状态、触发消息 ID、调用计数和安全错误文案。助手结果仍通过消息接口读取。

所有 API 均使用现有 Session Cookie 鉴权。写请求还必须通过现有 Origin 校验。消息历史 API 的分页只影响单次响应，数据库仍保存全部消息，页面可以通过游标读取完整历史；模型上下文的最近 20 轮规则由后续 Worker 调用 `getRecentContext` 时使用。

发送消息请求体仅接受 `content`，保留代码缩进和换行，最长 20000 个字符；不接受客户端指定用户身份、工具消息或内部元数据。幂等键为 UUID，首次返回 `202`，同内容重试返回既有消息和运行并使用 `200`，内容冲突返回 `409`。同会话已有其他在途运行时返回 `CONVERSATION_BUSY`。

公开响应不返回会话内部状态、工具载荷、消息元数据或子 Agent/Skill/Tavily 内部摘要。工具消息保留序号定位字段，内容为 `null`；失败运行返回固定公开文案，原始错误保留在服务端。接口字段同步记录在 `packages/contracts/openapi/core.yaml`。

会话详情的教学状态快照只包含白名单字段：`pending_question` 是当前需要用户回答的单一主要问题，没有待回答问题时为 `null`；`hint_level` 是 `0` 到 `3` 的整数，缺失或异常时为 `0`。页面历史仍可通过游标读取全部消息，模型上下文仍由 Worker 固定限制为最近 20 个用户轮次。

本阶段只创建数据库中的 `queued` 记录，尚未投递队列或执行模型。接入队列和 Worker 前，发送后运行会保持 `queued`，同会话的新消息受到在途运行保护。

## 调用顺序

1. `createConversation` 创建会话，允许目标和来源错题为空；非空引用必须属于当前用户。
2. `createQueuedRun` 在同一事务中保存用户消息、分配 `turn_no` 和创建 `queued` 运行；同一会话和幂等键重试返回已有记录，内容改变则报冲突。
3. `startOwnedRun` 领取运行；仅 `started: true` 的调用者可执行。重复领取不再次执行，失败恢复的队列策略将在后续任务中接入。
4. `appendRunMessages` 保存助手和工具消息；`updateRunningRun` 写入累计统计快照，不重复增加计数。
5. `finishOwnedRun` 原子保存最终消息、运行终态、统计和会话阶段。相同结果可重试，已结束运行不接受新消息。

## 消息与上下文

全部消息按 `sequence_no` 连续保存。`listOwnedMessages` 提供历史游标分页；`getRecentContext` 固定读取最近 20 个 `turn_no` 内的全部消息，包含当前尚未回复的用户轮次，不截断该轮工具调用链，也不删除更早的消息。

同一会话仅允许一个 `queued` 或 `running` 运行，所有写入以会话行锁串行化。关闭会话前须结束当前运行。助手消息和工具消息的 `id` 必须在首次请求前生成，重试时复用；不得每次重试重新生成。

## 验证

应用服务和 API 的单元测试覆盖 Session 归属、Origin、参数校验、代码缩进、幂等响应、完整历史分页、刷新恢复与内部信息隔离。在 Web 目录运行：

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/learning-assistant-service.test.ts tests/unit/learning-assistant-api.test.ts
```

数据库集成测试仅在显式设置 `LEARNING_ASSISTANT_TEST_DATABASE_URL` 时运行；默认测试流程跳过。测试创建随机用户及会话，结束后清理这些测试数据，不改动已有业务记录。

在 Web 目录下使用本地 `infra/.env` 开发数据库执行：

```powershell
node --env-file=../../infra/.env --input-type=module -e 'process.env.LEARNING_ASSISTANT_TEST_DATABASE_URL = process.env.DATABASE_URL; process.argv = [process.argv[0], "vitest", "run", "tests/integration/learning-assistant-repository.test.ts"]; await import("./node_modules/vitest/vitest.mjs");'
```
