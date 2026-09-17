# workflows：AgentRun 业务工作流

本目录实现各 `run_type` 的业务编排。

按 [docs/09](../../docs/09-全栈TypeScript迁移方案.md) 第 8.2 节，四个工作流最终将以 LangGraph.js 图实现；
当前为**显式异步实现**，用于先打通链路与验证行为等价，函数签名与图状态的设计保持一致，便于后续替换。

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

已知缺口（阶段 5 补齐）：未接入 Tavily 远程 MCP，因此所有阶段都不提供工具、`tool_call_count` 恒为 0、
`search_extract` 恒为 `not_used`；题集管线只有 initial 与 repair 两阶段，缺少 `tavily_recovery` 兜底；
两个工作流传入的修复指令都已删去与联网检索相关的句子。
