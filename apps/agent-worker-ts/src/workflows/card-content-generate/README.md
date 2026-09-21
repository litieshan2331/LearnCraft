# card-content-generate：节点知识内容生成（run_type=card_content_generate）

- `index.ts`：工作流主体（取连接 → 单会话 ReAct 生成与自纠 → 幂等持久化 → 返回摘要与用量）：
  `runCardContentGenerate`、`createCardContentGenerateWorkflow`、会话内解析与依赖端口；
  转出 `schema/` 的合同。
- `schema/index.ts`：输入合同 `CardContentGenerationInputSchema`、节点内容合同
  `CardContentDocumentSchema`（foundation、worked_example、pitfalls_debug、source_refs、
  teaching_memory，与 Web 的 `/card-content-result` 一致）与宽松规范化 + 严格校验的
  `parseCardContentDocument`（失败时通过 `CardContentParseError.validationPaths` 给出字段路径）。
- `prompts/index.ts`：单一 persona 的系统提示词、校验反馈文案与用户提示词组装。

会话循环复用 `../../application/services/tool-aware-generator.ts` 的 `runReactAgentSession`。
