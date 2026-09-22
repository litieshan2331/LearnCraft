# schema：card_content_generate 输入与内容合同

- `index.ts`：`CardContentGenerationInputSchema` / `CardContentGenerationInput`
  （agent_role 固定 node_tutor、plan_node.id 必填）；`CardContentDocumentSchema`（`card_content.v2`）
  及各子合同 `CardContentWorkedExampleSchema`、`CardContentFileSchema`、`CardContentCallStepSchema`；
  受控常量 `CARD_CONTENT_LANGUAGES`、`CARD_CONTENT_FILE_ROLES`、`CARD_CONTENT_FILE_LIMITS`；
  `CardContentParseError`、`normalizeCardContent`（宽松规范化，Python 真值语义来自
  `../../shared/python-compat.ts`，兼容 v1 的 `worked_example.code` 与字段别名）与
  `parseCardContentDocument`。
- 跨字段约束由 `CardContentWorkedExampleSchema` 的 `superRefine` 执行：文件路径不重复、字符数上限、
  `entry_file` 属于 `files[]`、`call_sequence` 步骤连续且 `file` 属于 `files[]`。
- `languageFromPath` / `normalizeLanguage`：未填写 language 时按扩展名推断，未知语言回落 `text`。
