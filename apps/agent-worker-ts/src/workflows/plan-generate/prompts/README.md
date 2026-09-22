# prompts：plan_generate 提示词

- `index.ts`：`SYSTEM_PROMPT`（学习路线规划师人格、`learning_plan.v1` 路线合同、工具调用与自纠协议）、
  `buildValidationFeedback`（含路线合同的字段与结构规则）与 `buildUserPrompt`。
- `SYSTEM_PROMPT` 按固定七节组织，顺序不可调换：#角色定义 / #事实边界 / #场景约束 / #工作流程 /
  #工具调用 / #输出规则 / #示例；`#示例` 是一正一反两个样例，反例按「错误片段 → 违反规则 → 正确写法」给出。
  #输出规则末尾附一份输出前自检清单。
