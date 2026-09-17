# llm：模型出网与凭据

本目录是 Agent 调用用户所选 Provider 的唯一出口，同时承担 SSRF 防护与凭据解密；
业务工作流不得绕过它直接发起模型请求。

文件：

- `public-address.ts`：公网地址判定，自建拒绝表以替代 Python 的 `ipaddress.is_global`，并解包
  IPv4-mapped IPv6 与 NAT64。
- `egress-policy.ts`：Base URL 策略与 DNS 全结果校验，返回“被钉死”的连接地址与被规范化的端点。
- `safe-egress-client.ts`：以固定 IP 连接但按原域名做 SNI 与证书校验、显式 Host 头、禁止重定向、
  按解压后字节限制响应体、SSE 结构校验，以及出网前写审计且写失败即拒绝（fail-closed）。
- `credential-decryptor.ts`：解密内部接口返回的凭据信封，错误码与 Python 的 `ModelCredentialDecryptor` 一致。

加密算法、AAD 与密钥长度校验由共享包 `@learncraft/security-primitives` 统一实现，本目录不重复实现格式。
