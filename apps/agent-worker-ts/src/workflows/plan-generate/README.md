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

启用 Human-in-the-Loop 时，Worker 先使用 PostgreSQL Checkpointer 编译固定的人工确认图，模型基于冻结的目标、画像和前测快照生成 1–3 个问题；TypeScript 校验后调用 `interrupt()`，AgentRun 进入 `waiting_for_human` 并结束当前 BullMQ Job。答案提交后以 `plan_generate:<agent_run_id>` 作为同一 `thread_id`，通过 `Command({ resume })` 恢复，再把结构化答案交给现有 `runReactAgentSession` 生成并校验 `learning_plan.v1`。`interrupt()` 前的节点只读取和构造问题，不执行不可幂等副作用。
