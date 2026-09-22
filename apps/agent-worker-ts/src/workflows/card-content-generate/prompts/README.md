# prompts：card_content_generate 提示词

- `index.ts`：`SYSTEM_PROMPT`（Node Tutor 人格、`card_content.v2` 内容合同、工具调用与自纠协议）、
  `buildValidationFeedback`（把 zod 字段路径翻译成 v2 合同的中文自纠要求）与 `buildUserPrompt`。
- 提示词强制逐文件输出 `worked_example.files[]`、禁止用 `// path` 注释行分隔代码、要求
  `call_sequence` 使用真实函数名、`expected_output` 以“文件路径 › 函数名：”开头。
