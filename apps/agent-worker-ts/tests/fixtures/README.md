# fixtures：测试夹具

- `test-only-cert.pem` / `test-only-key.pem`：仅用于回环 TLS 测试的自签证书（CN 与 SAN 均为
  api.example.com），**不是任何环境的真实凭据**，可以安全提交与公开。
- `openssl.cnf`：生成上述证书所用的最小 OpenSSL 配置。

重新生成（有效期十年）：

```powershell
$env:OPENSSL_CONF = (Resolve-Path openssl.cnf).Path
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-only-key.pem -out test-only-cert.pem -days 3650
```
