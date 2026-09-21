# assessment-generate：前测题集生成（run_type=assessment_generate）

- `index.ts`：工作流主体（读取输入快照 → 内部接口取连接 → 解密凭据 → 单会话 ReAct 生成与自纠 →
  幂等持久化 → 返回摘要与用量）：`runAssessmentGenerate`、`createAssessmentGenerateWorkflow`、
  依赖端口与结果类型；转出 `schema/` 的输入合同。
- `schema/index.ts`：输入合同 `AssessmentGenerationInputSchema`（extra 忽略、diagnostic 题量 10-20）。
- `prompts/index.ts`：单一 persona 的系统提示词、校验反馈文案与用户提示词组装。

会话循环复用 `../../application/services/tool-aware-generator.ts` 的 `runReactAgentSession`，
题集校验与元数据映射复用 `../shared/question-set-validation.ts`。
