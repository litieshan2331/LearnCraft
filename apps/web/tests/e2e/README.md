# 学习助手端到端测试

## 当前覆盖

Playwright 使用登录后的 `/onboarding` 页面，检查可访问入口、发送控件和刷新后的入口。API 客户端与 Web Route 的 Vitest 覆盖 Session 身份、消息游标、公开字段、忙碌错误和幂等 Header。Worker 侧学习助手图、队列处理器和 PostgreSQL Checkpoint 恢复测试分别位于 `apps/agent-worker-ts/tests`。

目前尚未提供把 Web、Outbox Dispatcher、BullMQ Worker、测试数据库和可脚本化假模型编排为单一进程组的完整 E2E harness；浏览器测试不会替代这部分验收。启用前必须先以隔离配置启动所有依赖服务。

## 显式环境

运行前设置以下变量，不能从 `infra/.env`、根 `.env`、`DATABASE_URL` 或 `REDIS_URL` 推导：

- `LEARNING_ASSISTANT_E2E_WEB_URL`：测试 Web 地址。
- `LEARNING_ASSISTANT_E2E_TEST_DATABASE_URL`：专用 PostgreSQL 测试库，库名必须包含 `test` 或 `e2e`。
- `LEARNING_ASSISTANT_E2E_TEST_REDIS_URL`：专用 Redis 测试实例，必须使用非 `0` 的数据库编号。
- `LEARNING_ASSISTANT_E2E_DISPATCHER_URL`：已启动的 Dispatcher 健康端点地址。
- `LEARNING_ASSISTANT_E2E_WORKER_URL`：已启动的 Worker 健康端点地址。
- `LEARNING_ASSISTANT_E2E_TEST_USER_EMAIL`、`LEARNING_ASSISTANT_E2E_TEST_USER_PASSWORD`：仅存在于测试数据库中的用户。
- `LEARNING_ASSISTANT_E2E_MODEL=fake`：显式声明假模型模式。Worker 健康端点必须报告 `model_mode=fake`；fake 模式只消费学习助手队列、停用普通 Worker，并将工具端口替换为本地失败响应。
- `LEARNING_ASSISTANT_E2E_FAKE_SCENARIO`：可选默认场景，支持 `ordinary`、`wrong-answer`、`hint-upgrade`、`insufficient-evidence`、`model-failure`、`tool-failure` 和 `crash-once`；单条消息也可使用 `[[e2e:<scenario>]]` 覆盖。

Playwright 全局预检会拒绝缺失配置、数据库名不符合约定、Redis DB 0、非 `fake` 模式以及未报告预期服务名的健康端点。预检不会读取凭据文件，也不会自动启动 Dispatcher 或 Worker。

## 命令

在 `apps/web` 目录执行：

```powershell
pnpm test:e2e
```

要由 Playwright 启动 Web，可额外设置 `LEARNING_ASSISTANT_E2E_START_WEB=1`；Web 所需的应用环境仍需由调用方显式配置。当前浏览器夹具尚未实现数据库/Checkpoint/Redis 的逐测试 teardown，因此只能在专用测试库和专用 Redis 实例中运行，执行后由外部 harness 负责销毁整个测试环境。

## 验收边界

在 fake Worker harness 可用之前，不得将浏览器冒烟测试记录为 Web → Outbox → BullMQ → Worker → LangGraph 全链路通过。不得使用真实 Provider、生产凭据、开发库或共享 Redis DB 0 执行该套测试。
