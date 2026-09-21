# schema：plan_generate 输入与路线输出合同

- `index.ts`：`PlanGenerationInputSchema` / `PlanGenerationInput`（三层嵌套对象 extra=forbid、
  weekly_minutes 30-10080）；`LearningPlanNodeSchema` / `LearningPlanDocumentSchema`
  （节点字段约束 + node_key 唯一、ordinal 从 1 连续、依赖存在且不自依赖、依赖图无环）、
  `hasPlanCycle` 与 `planValidationPaths`。
