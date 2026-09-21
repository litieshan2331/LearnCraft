# plan-generate：学习路线生成（run_type=plan_generate）

- `index.ts`：工作流主体（取连接 → 单会话 ReAct 生成与自纠 → 幂等持久化 → 返回摘要与用量）：
  `runPlanGenerate`、`createPlanGenerateWorkflow`、会话内解析与元数据映射
  （`planGenerationPath`）与依赖端口；转出 `schema/` 的合同。
- `schema/index.ts`：输入合同 `PlanGenerationInputSchema` 与路线输出合同
  `LearningPlanDocumentSchema`（node_key 唯一、ordinal 连续、依赖存在且无环），
  与 Web 的 `/plan-result` 校验一致。
- `prompts/index.ts`：单一 persona 的系统提示词、校验反馈文案与用户提示词组装。
- `recovery/index.ts`：宽松规范化 `normalizeRecoveryDocument`（旧字段名、字符串难度、脏 node_key、
  以标题书写的依赖收敛回合同）；会话内严格校验失败后会先经它收敛再严格校验，对应 Python
  `plan_generate.py` 底部的同名函数族。

会话循环复用 `../../application/services/tool-aware-generator.ts` 的 `runReactAgentSession`。
