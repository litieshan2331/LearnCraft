# prompts：card_content_generate 提示词

- `index.ts`：`SYSTEM_PROMPT`（Node Tutor 人格、`card_content.v2` 内容合同、工具调用与自纠协议）、
  `buildValidationFeedback`（把 zod 字段路径翻译成 v2 合同的中文自纠要求）与 `buildUserPrompt`。
- `SYSTEM_PROMPT` 按固定七节组织，顺序不可调换：#角色定义 / #事实边界 / #场景约束 / #工作流程 /
  #工具调用 / #输出规则 / #示例；`#示例` 是一正一反两个样例，反例按「错误片段 → 违反规则 → 正确写法」给出。
  #输出规则末尾附一份输出前自检清单。
- 提示词强制逐文件输出 `worked_example.files[]`、禁止用 `// path` 注释行分隔代码、要求
  `call_sequence` 使用真实函数名、`expected_output` 以“文件路径 › 函数名：”开头。
- 提示词把 `foundation`、`worked_example.explanation`、`expected_output` 限定为四种轻量排版约定：
  空行分段、行首 `- ` 列点（缩进 2 个空格为下一层）、`## ` 小节标题、行内 `**加粗**`。这四种与 Web 侧
  `presentation/content-text-blocks.ts` 的解析规则一一对应；提示词要求列点一律用 `- `、不写数字编号
  （Web 侧解析器仍兼容 `1.`/`1、`，只作兜底）；其它 Markdown 不会被解析，只当普通文本显示。
