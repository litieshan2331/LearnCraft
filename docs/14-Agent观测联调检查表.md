# Agent 观测平台联调检查表

> 目的：使用真实 PostgreSQL、认证 Redis、队列 Redis、Web、Dispatcher 和 Worker，验证四类工作流的完整观测链路。
>
> 约束：联调使用真实依赖和真实模型连接，不启用额外的故障注入开关。

## 一、联调前准备

- [ ] `infra/.env` 已配置 `CREDENTIAL_ENCRYPTION_KEY`、`MODEL_EGRESS_ENABLED=true`、`MODEL_EGRESS_ENVIRONMENT=development`。
- [ ] 已配置一个当前账户可用的默认模型连接；需要 Tool 场景时再配置 `TAVILY_API_KEY`。
- [ ] 已执行数据库迁移：`pnpm --filter @learncraft/web db:migrate`。
- [ ] 检查编排配置：`docker compose -f infra/compose.yaml --env-file infra/.env config --quiet`。
- [ ] 启动真实依赖：`docker compose -f infra/compose.yaml --env-file infra/.env up --build -d`。
- [ ] 检查服务：`docker compose -f infra/compose.yaml ps`；Web、Dispatcher、Worker、PostgreSQL、两个 Redis 均为 healthy/running。
- [ ] 检查 Worker：`docker compose -f infra/compose.yaml exec agent-worker-ts node -e "fetch('http://127.0.0.1:8080/ready').then(r=>r.text()).then(console.log)"`。

## 二、统一观测验收

- [ ] 在 Web `/observability` 只能看到当前用户自己的运行。
- [ ] `/observability/{runId}` 能打开摘要和 DSH 风格轨迹时间线。
- [ ] `/events?after=N` 只返回 `sequence_no > N` 的事件，下一游标可继续读取且无重复。
- [ ] `/events/stream?after=N` 先补发历史事件，再追加新事件；浏览器断线后从最后序号续传。
- [ ] 事件中能看到最终 Provider Prompt/config、模型正文、Thinking、Tool 输入/输出、时间、Token。
- [ ] 未返回 Thinking 的模型在详情中显示“未提供”，不伪造正文。
- [ ] 使用另一账户访问该 `runId` 的摘要、事件和 SSE，均返回 404。
- [ ] 删除学习目标/路线后，`agent_runs` 与 `agent_trace_events` 均级联删除。

## 三、四类工作流

分别触发并记录 `runId`，确认列表、摘要、事件和最终业务结果都成功：

- [ ] `assessment_generate`：前测题集生成及完整模型轨迹。
- [ ] `plan_generate`：6–12 章路线生成及完整模型轨迹。
- [ ] `card_content_generate`：章节卡片内容生成及 Tool/模型轨迹。
- [ ] `posttest_generate`：后测题集生成及完整模型轨迹。

## 四、异常与恢复场景

- [ ] **取消**：运行中调用取消接口；AgentRun 进入 `cancelled`，SSE 结束，轨迹尾部无虚构完成事件。
- [ ] **Worker 重启**：运行长任务时执行 `docker compose ... restart agent-worker-ts`；BullMQ 重投后运行不会产生重复业务结果，轨迹序号连续，最终状态正确。
- [ ] **最终失败**：关闭模型连接或使用不可重试错误；确认 `run.failed`、`llm.attempt.failed` 和错误摘要都可查。

## 五、联调后清理

- [ ] 清理本次测试目标及其观测数据，确认级联删除没有残留。
- [ ] 保存 Web/Worker 日志、失败 `runId`、SSE 断线时间和数据库查询结果。

## 六、关键数据库检查

```sql
select id, owner_id, run_type, status, retry_count, input_tokens, output_tokens
from agent.agent_runs
order by created_at desc
limit 20;

select agent_run_id, sequence_no, event_type, turn_no, attempt_no,
       input_tokens, output_tokens, started_at, finished_at
from agent.agent_trace_events
where agent_run_id = '<runId>'
order by sequence_no;
```
