# schemas：运行时契约

本目录存放 zod 运行时校验 schema，是“数据能否被信任”的唯一判定点；TypeScript 类型不能替代校验。

文件：

- `core-internal.ts`：Web 内部接口 5 个端点的响应契约（全部 strict，等价 Pydantic 的 `extra="forbid"`）。
- `assessment-question-set.ts`：题集业务契约（与 Web 侧 assessment-result 路由的 schema 一致），
  以及 `extractJsonText`（剥离 Markdown 代码围栏）。

注意：zod v4 的 `z.uuid()` 会校验 RFC 版本与变体位，比 Pydantic 的 UUID 更严格；
正常数据由 `gen_random_uuid()` 生成不受影响，但非标准 UUID 会被本实现拒绝。
