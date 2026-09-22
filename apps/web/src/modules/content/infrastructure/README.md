# Content 基础设施层

- `drizzle-card-content-query-repository.ts`：读取 `card_contents.public_content_json` 与 `schema_version`，
  经 `normalizeWorkedExample` 归一化为 v2 视图，内容不可用时返回 null。
- `card-content-worked-example-normalizer.ts`：`normalizeWorkedExample` 按版本分发——v2 直接映射，v1 的
  `worked_example.code` 由 `splitLegacyCodeIntoFiles` 按 `// 路径` 注释行切分为多个文件（回落路径 `main`，
  丢弃首个标记前的说明文字）；`readV2Files` / `readV2CallSequence` / `readLegacyCallSequence` 负责字段读取与别名兼容。
- `code-highlighter.ts`：Shiki 单例高亮器（`SHIKI_THEME = github-dark`，只注册受控语言，`structure: inline`），
  对外 `highlightCardContentCode(code, language)` 与 `highlightWorkedExampleFiles(files)`（返回 path → HTML 映射）；
  未注册语言自动回落纯文本。它由读取接口 `GET /api/v1/card-contents/{id}` 在**服务端**调用（示例区在客户端组件里渲染），
  因此**不要**在客户端组件里引入本模块——否则会把 Shiki 打进浏览器包。
- 对象存储、pgvector 只读检索与 Worker 内部 HTTP adapter 仍为后续扩展点。
