# commands：用例入口

文件：

- `execute-agent-run.ts`：AgentRun 执行命令（等价于 Python 的 `execute_agent_run` 与 Celery 任务的 except 分支）。

包含：

- `AgentRunTask`：队列消息 DTO（`agent_run_id` / `trace_id` / `task_version=1`）。
- `executeAgentRun`：领取 → 取消检查 → 按 `run_type` 路由 → 执行工作流 → 回写成功。
  **回写时把工作流返回的真实 token 用量写入 `agent_runs`**（已确认的与 Python 差异，Python 恒定写 0）。
- `RetryableAgentRunError` / `NonRetryableAgentRunError`：异常归类。
- `calculateRetryDelaySeconds` / `handleAgentRunFailure`：队列侧退避（10/20/40… 封顶 300 秒）与最终失败。
