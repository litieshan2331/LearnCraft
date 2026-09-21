# schema：card_content_generate 输入与内容合同

- `index.ts`：`CardContentGenerationInputSchema` / `CardContentGenerationInput`
  （agent_role 固定 node_tutor、plan_node.id 必填）；`CardContentDocumentSchema` 及各子合同、
  `CardContentParseError`、`normalizeCardContent`（宽松规范化，Python 真值语义来自
  `../../shared/python-compat.ts`）与 `parseCardContentDocument`。
