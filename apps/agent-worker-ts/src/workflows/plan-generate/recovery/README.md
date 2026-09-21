# recovery：路线兜底宽松规范化

- `index.ts`：`normalizeRecoveryDocument` 与辅助收敛函数（对应 Python `plan_generate.py` 底部的
  `_normalize_recovery_document` 函数族）：仅在多轮严格校验都失败后的兜底恢复阶段使用，
  规范化后仍要经过路线合同严格校验。Python 真值语义与 round 来自 `../../shared/python-compat.ts`。
