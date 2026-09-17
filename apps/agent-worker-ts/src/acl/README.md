# acl：Web 内部接口防腐层

本目录封装 Worker 调用 Web 私有内部接口的全部细节，把 HTTP 与 JSON 的差异挡在业务之外；
业务工作流只依赖这里返回的受信任类型，不直接拼 URL 或处理状态码。

文件：

- `core-internal-client.ts`：`CoreInternalClient`，覆盖 5 个内部端点
  （默认模型连接、节点内容上下文、题集回写、路线回写、节点内容回写），
  统一超时、`x-learncraft-internal-secret` 鉴权、错误分类与响应契约校验。

实现约定：错误分类与 Python 的 `WebCoreInternalClient` 完全一致 —— 网络异常与 5xx 可重试；
404/401/403、契约不符及其余非 2xx 不可重试；未配置服务密钥时在发请求之前就失败。
