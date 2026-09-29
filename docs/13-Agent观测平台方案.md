# Agent 观测平台方案

> 状态：实施方案
>
> 日期：2026-09-29

## 一、目标

在 LearnCraft 中增加独立的“Agent 观测”模块，复用 DSH `ui-trajectory` 的时间线、轨迹表和详情检查器，持久化每次 AgentRun 的完整执行轨迹：

- 实际发送给 Provider 的完整 Prompt 和请求配置；
- 模型正文输出；
- 可获得的完整 Thinking；
- Tool 原始输入与输出；
- 重试、模型回退、错误、时间戳和 Token 用量。

第一期不做观测权限细分，所有已登录用户均可查看观测数据。删除学习路线时，硬删除该路线关联的 AgentRun 和全部观测事件。

## 二、总体方案

```text
Agent Worker
  └─ TraceWriter ── PostgreSQL agent.agent_trace_events
                         │
                         ├─ 分页查询 API
                         └─ 带游标实时 SSE
                                   │
LearnCraft /observability ── DSH 轨迹展示层
```

不直接把 DSH 插件作为 LearnCraft 插件安装。DSH 的 `ui-trajectory` 依赖 Cordis、Session Controller、Conversation View Ring 和 DSH Session 事件；LearnCraft 只移植其展示层，并把 LearnCraft 事件适配成自己的轨迹记录模型。

## 三、数据落库

新增 `agent.agent_trace_events` 表，建议字段如下：

| 字段 | 说明 |
| --- | --- |
| `id` | bigserial 主键 |
| `agent_run_id` | 外键，引用 `agent.agent_runs.id`，`ON DELETE CASCADE` |
| `sequence_no` | 单次运行内递增序号 |
| `event_type` | 事件类型 |
| `turn_no` / `step_no` / `attempt_no` | 轮次、步骤、模型尝试编号，可为空 |
| `started_at` / `finished_at` | 事件开始和结束时间 |
| `input_tokens` / `output_tokens` | 本次模型调用用量，可为空 |
| `payload_json` | 完整 Prompt、输出、Thinking、Tool 输入/输出等 JSONB |
| `created_at` | 数据库时间 |

建议事件类型：

- `run.started`、`run.completed`、`run.failed`；
- `llm.request.started`：最终请求元数据和 Prompt；
- `llm.attempt.completed`：本次尝试的模型输出、Thinking、流式时间点、用量；
- `llm.retry`、`llm.fallback`：重试和模型回退原因；
- `tool.started`、`tool.completed`：Tool 原始输入、原始输出和错误；
- `validation.failed`、`turn.completed`。

API Key、解密凭据和其他密钥不得写入 `payload_json`。Prompt、Tool 输入/输出和 Thinking 可以完整写入 JSONB；暂不设置保留期，随学习路线级联硬删除。

## 四、采集链路

1. 新增 Worker 侧 `TraceWriter` 端口和 PostgreSQL 实现，所有写入按 `agent_run_id` 的行锁生成连续 `sequence_no`。
2. 在 [model-gateway.ts](D:/Project_Zy/LC/LearnCraft/apps/agent-worker-ts/src/infrastructure/llm/model-gateway.ts:190) 的最终请求路径记录实际 Provider 请求：包括最终 `messages`、工具定义、`tool_choice`、`thinking`、`response_format`、Provider、模型和时间戳；不记录 API Key。
3. 每次重试单独记录 `llm.request.started` 和 `llm.attempt.completed`。主模型耗尽重试后切换备用模型时，追加 `llm.fallback`，不能覆盖主模型尝试。
4. 在模型流聚合完成时写入完整正文、完整 Thinking、工具调用、结束原因和 Token 用量。模型未返回 Thinking 时写入 `thinking: null`，前端显示“未提供”。
5. 在 [tool-aware-generator.ts](D:/Project_Zy/LC/LearnCraft/apps/agent-worker-ts/src/application/services/tool-aware-generator.ts:143) 的 Tool 调用前后写入原始 JSON 参数、原始结果、错误、开始时间和结束时间；实时进度仍可继续使用 Redis，但不再作为历史数据来源。
6. 运行成功、失败、取消和重试时，Worker 与观测事件在同一状态更新事务中写入，保证轨迹尾部与 AgentRun 状态一致。

## 五、查询接口

新增观测查询接口：

- `GET /api/v1/observability/runs`：按运行类型、状态、目标路线和时间分页查询运行列表；
- `GET /api/v1/observability/runs/{runId}`：查询运行摘要；
- `GET /api/v1/observability/runs/{runId}/events?after=&limit=`：按 `sequence_no` 游标分页读取完整轨迹；
- `GET /api/v1/observability/runs/{runId}/events/stream?after=`：SSE 实时追加事件，支持断线后按游标补发。

第一期接口不按 `owner_id` 做权限过滤，但仍通过现有登录 Session 进入应用，避免把完整 Prompt 和模型内容暴露到未登录公网。

## 六、UI 移植

优先复用 DSH `packages/client/ui-trajectory/src/client/` 中的：

- `TrajectoryTimeline.tsx`：时间概览；
- `TrajectoryTable.tsx`、`TrajectoryCell.tsx`：轨迹表和详情检查器；
- `TrajectoryTurn.tsx`、`TrajectoryGroupHeader.tsx`：轮次分组；
- `layout.ts`、`timeline.ts`、`trajectory-record.ts`：纯布局和记录模型；
- CSS Modules、搜索、虚拟滚动、代码查看和 JSON 树展示。

需要重写的 DSH 接入部分：

- `useSession`、`useTrajectory` 和 Session Window；
- Cordis `ctx`、`conversation.view` Slot 注册；
- `trajectory-*-definition.ts` 的 DSH Session 事件解释器。

LearnCraft 新增页面：

- `/observability`：运行列表；
- `/observability/[runId]`：轨迹详情页。

在 [apps/web/src/app/(learn)/layout.tsx](D:/Project_Zy/LC/LearnCraft/apps/web/src/app/(learn)/layout.tsx) 导航中增加“Agent 观测”。

## 七、执行步骤

1. 建立 `agent_trace_events` Drizzle Schema、迁移和级联删除测试。
2. 实现 Worker `TraceWriter`，先接入运行开始/结束、Tool 和模型调用完成事件。
3. 改造模型网关，补齐最终 Prompt、重试、回退、正文、Thinking、时间和 Token 记录。
4. 增加列表、摘要、游标分页和 SSE 接口。
5. 把 DSH 轨迹纯展示组件复制到 LearnCraft 观测模块，替换为 LearnCraft 事件适配器。
6. 增加导航、运行详情、空状态、加载、断线续传和超长 JSON 展示。
7. 联调四类工作流，验证模型重试、Tool 失败、模型无 Thinking、取消和 Worker 重启场景。
8. 保留 DSH [MIT 许可证](D:/deepseek-harness/LICENSE)及来源说明。

## 八、验收标准

- 同一 `runId` 的事件按序分页，断线后可从 `after` 游标继续；
- 轨迹中能看到最终 Prompt、模型正文、Thinking、Tool 输入/输出和重试/回退；
- 模型未提供 Thinking 时显示“未提供”，不伪造内容；
- 时间线使用真实开始/结束时间，未完成事件不虚构耗时；
- 删除学习路线后，关联 `agent_runs` 和 `agent_trace_events` 均不存在；
- 大型 JSONB 仍可展开、搜索和复制，页面不会一次性渲染全部历史行。
