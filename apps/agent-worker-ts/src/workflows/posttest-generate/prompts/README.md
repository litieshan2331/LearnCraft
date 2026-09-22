# prompts：posttest_generate 提示词

- `index.ts`：`SYSTEM_PROMPT`（后测设计师人格；节点内容与 `teaching_memory` 为主要出题依据，
  事实不确定时允许 `tavily_search` 核对）、`buildValidationFeedback`、
  `serializeCardContentContext`（按契约字段顺序序列化固定节点内容）与 `buildUserPrompt`。
- `SYSTEM_PROMPT` 按固定七节组织，顺序不可调换：#角色定义 / #事实边界 / #场景约束 / #工作流程 /
  #工具调用 / #输出规则 / #示例；`#示例` 是一正一反两个样例，反例按「错误片段 → 违反规则 → 正确写法」给出。
  #输出规则末尾附一份输出前自检清单。
- 示例里的 Markdown 三反引号围栏用 `String.fromCharCode(96)` 构造（`CODE_FENCE`），避免源码中出现字面围栏。
