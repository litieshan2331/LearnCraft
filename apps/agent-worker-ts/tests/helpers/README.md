# tests/helpers：测试替身

本目录存放多个测试文件共用的替身，文件名不带 `.test.` 后缀，因此不会被 Vitest 当作用例收集。

文件：

- `fake-tool-gateway.ts`：`FakeToolGateway` 与 `fakeToolDeps` —— 记录型联网工具替身，
  默认返回一次成功的搜索+提取结果，也可注入失败结果以覆盖降级路径。
- `live-tavily-gateway.ts`：`createLiveTavilyToolGatewayFactory` —— 真实用例用的 Tavily 网关工厂，
  按运行所属账户构造网关并把配额指向 `TAVILY_QUOTA_REDIS_URL`。
