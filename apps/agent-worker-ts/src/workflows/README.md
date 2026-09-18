# workflows：AgentRun 业务工作流

本目录实现各 `run_type` 的业务编排。

当前为**显式异步实现**，函数签名与状态设计保持可替换性，便于日后改为 LangGraph.js 图（可选项，见 `docs/09` 待办清单第 7 项）。

文件：

- `question-set-pipeline.ts`：`runQuestionSetStages` —— 前测与后测**共用**的题集管线
  （首轮生成 → 修复、恢复消息顺序、结构校验、错误取舍；`buildRecoveryMessages`、`validateQuestionSet`），
  对应 Python 的 `workflows/question_set_generation.py`。
- `assessment-generate.ts`：`runAssessmentGenerate` / `createAssessmentGenerateWorkflow` —— 前测题集生成
  （读取输入快照 → 内部接口取连接 → 解密凭据 → 模型生成 → 结构校验与一次修复 → 幂等持久化）。
- `posttest-generate.ts`：`runPosttestGenerate` / `createPosttestGenerateWorkflow` —— 节点后测生成
  （先读固定 CardContent 上下文，再取账户默认模型连接，只依据节点内容与 `teaching_memory` 出题 → 幂等持久化）。
- `plan-document.ts`：`LearningPlanDocumentSchema` —— 章节式学习路线合同
  （节点字段约束 + node_key 唯一、ordinal 连续、依赖存在且不自依赖、依赖图无环），与 Web 的 `/plan-result` 校验一致。
- `plan-recovery.ts`：`normalizeRecoveryDocument` —— 路线兜底阶段的宽松规范化
  （旧字段名、字符串难度、脏 node_key、以标题书写的依赖收敛回合同），对应 Python `plan_generate.py` 底部的同名函数族。
- `plan-generate.ts`：`runPlanGenerate` / `createPlanGenerateWorkflow` —— 学习路线生成
  （取连接 → 首轮生成 → 两次修复 → 无资料兜底重建 → 幂等持久化）。
- `card-content-document.ts`：`CardContentDocumentSchema` / `parseCardContentDocument` —— 节点知识内容合同
  （foundation、worked_example、pitfalls_debug、source_refs、teaching_memory，与 Web 的 `/card-content-result` 一致）
  与宽松规范化（旧字段名、空对象回落、误区三字段强约束），每次解析都会先规范化。
- `card-content-generate.ts`：`runCardContentGenerate` / `createCardContentGenerateWorkflow` —— 节点内容生成
  （取连接 → 首轮生成 → 一次修复 → 无资料兜底重建 → 幂等持久化）。
- `python-compat.ts`：Python 真值语义与 round 的兼容层，供两个规范化器共用。

`src/main/worker.ts` 当前注册的 `run_type`：`assessment_generate`、`posttest_generate`、`plan_generate`、`card_content_generate`
（四个 P0 工作流已全部落地，每个都有单元测试与真实端到端用例）。
未注册的类型由命令层转为 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，不会伪造成功结果。

## 联网工具（Tavily 远程 MCP）

四个工作流共用 `infrastructure/mcp/tavily-tool-gateway.ts` 与 `application/services/tool-aware-generator.ts`：

- 题集类（`assessment_generate`、`posttest_generate`）：三阶段 initial → repair → tavily_recovery，
  是否开放工具由 `repairWithTavily` / `finalWithTavily` 决定（与 Python 的两个开关一致）；
- 路线与节点内容：首轮由模型自主决定是否调用工具，最终校验失败后先执行强制联网重建，
  联网不可用时退回无资料重建；
- 可见工具调用数写入 `tool_call_count`，assessment 另写 `search_extract`（0/非 0 决定）；
  每日配额按账户经 Redis 原子计数，配额不可用时拒绝联网而不是绕过。

**已知差异：** 调用参数按远端 `tools/list` 公布的 schema 过滤。远端 2026-09 起 `tavily_extract`
不再接受 `chunks_per_source`，Python 的硬编码参数会被远端以 `-32603` 拒绝；过滤后保留 Python 的参数语义，
同时不会因为远端删参而整体失败。
