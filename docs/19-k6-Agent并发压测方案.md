# 双 Worker 限流验证脚本及结果报告（简历版）

更新：2026-10-12。目标：给简历中的“Redis Lua 全局并发、API Key+模型及用户+模型并发与固定窗口 RPM”提供可复现证据。

## 1. 本次实现与验证范围

每次模型尝试获得独立 UUID 许可，在三个 Redis ZSET 中记录到期时间。Lua 原子检查所有并发与 RPM 桶；每 TTL/3 续期一次，出网前再确认许可。释放只删除自己的 ID，避免旧调用误删新调用。失效许可不允许续期复活；续期失败或本地保守截止时间到达，会通过 AbortSignal 中止实际模型请求。

RPM 窗口由 Redis TIME 在 Lua 内计算：`floor(redis时间毫秒 / 60000)`。释放许可和续期均不回补或增加 RPM；每次重新 acquire 才计一次。Redis 命令超时丢弃连接，避免迟到回复被下一条命令误读。

本次使用现有 `createAgentRunWorker`、真实 BullMQ、真实 Redis Lua、真实模型网关和 HTTPS SSE 传输。两个独立 Node 子进程各 4 个任务槽位，共用队列、限流前缀及配置；测试域名与测试证书通过现有依赖注入连接本机夹具，生产出网策略不变。验证器直接提交 BullMQ 任务，使用屏障保证两个 Worker 同时竞争。

| 简历能力 | 代码核验及本次实测范围 |
| --- | --- |
| PostgreSQL Outbox 异步投递 | 已有同事务写入和 SKIP LOCKED 投递；本次未实测数据库投递、重投及故障恢复 |
| BullMQ 长短任务分池 | 已有两个队列及各自并发配置；进程内仍共享数据库池和事件循环，本次未做分池延迟对比 |
| Redis Lua 三层并发、两层 RPM | 本次主验收；逐请求核验三个并发维度、两个 RPM 维度及双进程重叠 |
| TTL 与许可恢复 | 本次验证跨 TTL、持续非空桶、迟到释放、续期故障与真实进程崩溃 |

本次不调用付费模型，不操作业务数据库。测试 Worker 在结束后退出，原业务 Worker 未重启。此前共享计数 TTL 缺陷已按本方案修复。

## 2. 要测什么指标

| 指标 | 定义 | 用途 |
| --- | --- | --- |
| **合计在飞并发峰值** | 模型记录端统一记录请求开始/结束，按全局、凭据+模型、用户+模型重建在飞数量 | 主验收，所有维度均不超过上限；目标维度须达到限额 |
| **每固定窗口许可数** | 按 Lua 返回的真实窗口 ID 统计 acquire 成功次数，分别按凭据+模型、用户+模型分组 | 主验收，每窗口不超过 RPM；下一窗口恢复 |
| **越界次数** | 请求并发或窗口许可超过对应限额的事件 | 主验收为 0；P95/P99 不能代替正确性 |
| **拒绝次数与请求关联** | 本地 MODEL_RATE_LIMIT_EXCEEDED；拒绝任务不得到达模型端点 | 验证超额确实被拦截；实际出网须关联自己的成功许可 |
| **Worker A/B 参与** | 两个不同 PID 的目标请求数及请求重叠 | 防止仅单 Worker 工作而误判分布式验证通过 |
| **成功任务完成 P95/P99** | 入队提交至网关完成，包含队列、屏障等待与模型耗时；就近秩法 | 补充耗时，保留成功样本数；不是首字延迟 |
| **模型耗时 P95/P99** | 模型记录端请求开始至真实响应结束 | 单独写入 report.json，反映本机夹具耗时 |
| **TTL 与故障恢复** | 续期、幂等释放、失效不复活、实际流中止、崩溃后到期重获 | 验证长期调用和异常边界 |

许可数量可能大于实际出网数量，例如审计、预算或建连失败。RPM 衡量的是模型尝试许可；固定窗口允许分钟边界两窗额度连续放行，不能当作滚动 60 秒限制或所有 Provider 的额度规则。

## 3. 场景与实测结果

环境：Node v24.18.0，Redis 7.4.9，两个 Worker 各 4 槽位，合计 8。TTL 1 秒；并发场景 SSE 保持 1450ms，RPM 场景保持 100ms。模型请求重试 0，无备用模型。除被测维度外并发上限 100、RPM 1000。每个场景每轮提交 24 个独立任务，所有主场景重复 3 轮，RPM 复用各轮前缀覆盖两个相邻分钟窗口。

| 场景 | 被测上限 | 负载安排 | 验证要求 |
| --- | --- | --- | --- |
| G | 全局并发 3 | 双 Worker 并发提出额外需求 | 合计峰值 3，额外需求被拒绝 |
| K-C | 凭据+模型并发 2 | 不同用户共享 K1；K2 独立对照 | K1 峰值 2，K2 可调用 |
| U-C | 用户+模型并发 2 | U1 用不同凭据调用；U2 独立对照 | U1 峰值 2，U2 可调用 |
| K-R | 凭据+模型 RPM 5 | 同窗超过 5 次 K1 需求，含 K2 对照 | 每窗 K1 获准 5 次，拒绝额外需求，下一窗恢复 |
| U-R | 用户+模型 RPM 5 | 同窗超过 5 次 U1 需求，含 U2 对照 | 每窗 U1 获准 5 次，拒绝额外需求，下一窗恢复 |

最终运行：2026-10-12 12:22:33～12:24:08（北京时间），Worker A PID 19622、B PID 19623。
主场景共 504 个任务，243 次实际请求成功完成、261 次超额拒绝；每轮两 Worker 均参与，全部逐请求并发和窗口校验通过。

| 场景 | 轮数/窗口阶段 | 总任务 | 实测目标峰值或每窗许可 | 拒绝 | A/B 实际请求 | 每轮完成 P95/P99 范围（ms） | 越界 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G | 3 轮 | 72 | 合计并发峰值 3，上限 3 | 45 | 10/17 | 1478～1490 / 1478～1490 | 0 |
| K-C | 3 轮 | 72 | K1+M1 并发峰值 2，上限 2 | 36 | 18/18 | 1481～1494 / 1481～1494 | 0 |
| U-C | 3 轮 | 72 | U1+M1 并发峰值 2，上限 2 | 36 | 18/18 | 1480～1482 / 1480～1482 | 0 |
| K-R | 3 轮 × 2 窗口 | 144 | 每窗 K1+M1 许可 5，上限 5 | 84 | 28/32 | 129～151 / 129～151 | 0 |
| U-R | 3 轮 × 2 窗口 | 144 | 每窗 U1+M1 许可 5，上限 5 | 84 | 27/33 | 128～139 / 128～139 | 0 |

RPM 两个相邻窗口 ID 为 29862983、29862984。A/B 请求数包含独立身份对照；峰值及 RPM 数字仅按目标身份统计。表格的 P95/P99 范围是各轮分位数的最小～最大值，不是混合样本分位数。

原始证据：[中文报告](../apps/agent-worker-ts/test-results/rate-limit/2026-10-12T04-22-33-915Z-6a3dfba0/report.md)、[机器报告](../apps/agent-worker-ts/test-results/rate-limit/2026-10-12T04-22-33-915Z-6a3dfba0/report.json)、[逐事件记录](../apps/agent-worker-ts/test-results/rate-limit/2026-10-12T04-22-33-915Z-6a3dfba0/events.jsonl)。首轮完整运行亦通过，保存在同目录另一个 runId；最终运行使用包含 RESP 超时修复的代码。报告按场景、轮次、窗口阶段逐项保留；任何超限、非预期错误、任务缺失、双 Worker 不参与或未达到被测上限均返回非零退出码。

TTL 与故障边界已验证：

- 单次调用跨 1 秒 TTL 自动续期；正常结束及重复释放不影响新许可。
- 将旧许可 score 置为过期后重新获取，旧许可续期被拒绝，迟到释放不能删除新许可。
- 锚定长许可、连续轮换短许可，使桶持续非空超过 TTL，合计额度不丢失。
- 同凭据/用户的 M1 与 M2 分桶独立，全局并发跨模型共享。
- 单独注入限流 Redis 命令故障，队列 Redis 保持可用；真实 HTTPS SSE 被中止，后续 acquire 拒绝，TTL 后恢复。
- 持许可子进程 SIGKILL 后停止续期，TTL 到期重新获取成功。
- 续期响应挂起时本地截止时间中止；迟到成功响应不能恢复已中止信号；RESP 命令超时后的旧回复不能污染新命令。

故障注入是组件实验，不能等同于真实生产网络分区。中止本地连接也不能保证远端 Provider 立即停止计算；事件循环长时间暂停或网络不确定时，不能承诺远端计算并发绝对不越界。

## 4. 如何写进简历

可在原条目后补充：

> 在双 Worker 各 4 个槽位、合计 8 槽位条件下，用可控 HTTPS SSE 验证三层并发与两层固定窗口 RPM；每场景重复 3 轮，覆盖 TTL 续期、失效释放及窗口恢复，实测越界 0 次。

本次 P95/P99 每组仅约 9～12 个成功样本，P99 接近最大值，且响应时长人为固定。不要写成真实模型首字延迟、生产吞吐量、分池 P99 改善或真实 Provider 429 为 0。后续 k6 可用于 Web→Outbox 的负载与容量实验，本次确定性双进程验证不需要 k6。

## 5. 发布注意事项

并发键从整数计数切换为 `leases:v2` ZSET，旧、新版本不共享并发额度。正式启用时需要停止旧 Worker 接收新任务，等待在飞模型调用结束，再让全部 Worker 使用新版本及相同配置/前缀；禁止新旧限流器混跑。此次未重启或升级业务容器。

自动续期不能替代 Worker 的任务超时管理。本地截止按命令发出时计时，保留 TTL 的 20% 余量；故障时保守中止，可能降低可用性。TTL 值应按网络延迟和事件循环负载配置，本次 1 秒仅用于边界实验。

## 6. 执行步骤

在仓库根目录 PowerShell 执行，前提是现有 `learncraft-agent-worker-ts-1` 容器运行且已安装依赖。

1. 单测和类型检查（本次 82 通过、2 个未启用的真实 RESP 用例跳过，类型检查通过）：

   ```powershell
   docker exec --workdir /app/apps/agent-worker-ts learncraft-agent-worker-ts-1 node node_modules/vitest/vitest.mjs run tests/model-rate-limiter.test.ts tests/model-gateway.test.ts tests/safe-egress-client.test.ts tests/pinned-transport.test.ts tests/resp-client.test.ts tests/bullmq-agent-queue.test.ts tests/agent-run-processor.test.ts tests/bootstrap-config.test.ts tests/outbox-dispatcher.test.ts
   docker exec --workdir /app/apps/agent-worker-ts learncraft-agent-worker-ts-1 node node_modules/typescript/bin/tsc --noEmit
   ```

2. 创建独立 Redis，不发布宿主机端口：

   ```powershell
   $limitTestRedisName = 'learncraft-limit-verify-' + (Get-Date).ToString('yyyyMMddHHmmss')
   docker run -d --name $limitTestRedisName --network learncraft_private redis:7.4.9-alpine redis-server --save '' --appendonly no
   ```

3. 打包脚本，esbuild 是可执行文件，直接调用：

   ```powershell
   docker exec --workdir /app/apps/agent-worker-ts learncraft-agent-worker-ts-1 node_modules/esbuild/bin/esbuild tests/performance/double-worker-rate-limit.ts --bundle --platform=node --format=esm --target=node22 --outfile=node_modules/.cache/learncraft-double-worker.mjs --external:bullmq --external:pg --external:zod --external:undici --external:@modelcontextprotocol/sdk
   ```

4. 运行；脚本自行启动两个独立 Worker，约 1～2 分钟，等待真实 Redis 分钟切换：

   ```powershell
   $limitTestRedisUrl = 'redis://' + $limitTestRedisName + ':6379/0'
   docker exec --env "AGENT_LIMIT_TEST_REDIS_URL=$limitTestRedisUrl" --workdir /app/apps/agent-worker-ts learncraft-agent-worker-ts-1 node node_modules/.cache/learncraft-double-worker.mjs
   ```

5. 查看命令打印的报告目录，对应本地 `apps/agent-worker-ts/test-results/rate-limit/<runId>/`，包含 `report.md`、`report.json`、`events.jsonl`。结果目录受 gitignore 忽略，分享证据时需要一并保存。非零退出码或报告失败不得用于“已通过”的简历结论。

6. 清理本次 Redis，脚本自身只清理随机测试命名空间，不执行 FLUSHDB：

   ```powershell
   docker rm -f $limitTestRedisName
   ```
