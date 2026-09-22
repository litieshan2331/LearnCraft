# Content 领域层

- `content-query.ts`：卡片内容查询视图模型（`CardContentSnapshot`、`CardContentWorkedExampleView`、
  `CardContentFileView`、`CardContentCallStepView`）与内容合同常量 `CARD_CONTENT_LANGUAGES`、
  `CARD_CONTENT_FILE_ROLES`、`CARD_CONTENT_LIMITS`；这些常量同时被 worker 的 `schema/index.ts` 与内部路由
  `card-content-result` 的 zod 镜像引用，改动需三处同步。
- `languageFromPath` / `normalizeCardContentLanguage`：按扩展名推断并归一化代码语言。
- 受控资料、引用、卡片内容版本与 Demo 发布条件的领域规则和 repository interface 仍为后续扩展点。
