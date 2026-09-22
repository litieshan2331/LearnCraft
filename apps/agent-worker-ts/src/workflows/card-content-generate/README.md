# card-content-generate：节点知识内容生成（run_type=card_content_generate）

- `index.ts`：工作流主体（取连接 → 单会话 ReAct 生成与自纠 → 幂等持久化 → 返回摘要与用量）：
  `runCardContentGenerate`、`createCardContentGenerateWorkflow`、会话内解析与依赖端口；
  转出 `schema/` 的合同。
- `schema/index.ts`：输入合同 `CardContentGenerationInputSchema`、节点内容合同
  `CardContentDocumentSchema`（`schema_version=card_content.v2`；foundation、worked_example、
  pitfalls_debug、source_refs、teaching_memory，与 Web 的 `/card-content-result` 一致）与宽松规范化 +
  严格校验的 `parseCardContentDocument`（失败时通过 `CardContentParseError.validationPaths` 给出字段路径）。
- `worked_example` 在 v2 中按文件拆分：`files[]`（path / language / role / content，1–8 个文件，
  单文件 ≤ 6000 字符、合计 ≤ 24000 字符）、`entry_file` 必须是 `files[]` 中的路径、`call_sequence[]`
  用 `{step, file, function, note}` 指明“哪个文件的哪个函数”；`expected_output` 仍为单个字符串，
  由提示词约束以“文件路径 › 函数名：”开头，不做结构校验。
- `prompts/index.ts`：单一 persona 的系统提示词、校验反馈文案与用户提示词组装。

会话循环复用 `../../application/services/tool-aware-generator.ts` 的 `runReactAgentSession`。
