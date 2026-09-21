# prompts：posttest_generate 提示词

- `index.ts`：`SYSTEM_PROMPT`（后测设计师人格；节点内容与 `teaching_memory` 为主要出题依据，
  事实不确定时允许 `tavily_search` 核对）、`buildValidationFeedback`、
  `serializeCardContentContext`（按契约字段顺序序列化固定节点内容）与 `buildUserPrompt`。
