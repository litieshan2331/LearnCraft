# shared：跨工作流复用模块

- `question-set-validation.ts`：`validateQuestionSet`（题集严格校验，失败只返回脱敏字段路径）、
  `searchExtractLabel`（`search_extract` 元数据值）与 `recoveryStageLabel`（ReAct 会话结果 →
  语义兼容的 `recovery_stage`），由 `assessment-generate` 与 `posttest-generate` 共用。
- `python-compat.ts`：Python 真值语义与 round 的兼容层，供 `plan-generate/recovery`
  与 `card-content-generate/schema` 的规范化器共用。
