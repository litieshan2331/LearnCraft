# @learncraft/security-primitives

Web 与 Agent Worker 共用的安全原语包，避免同一套加密实现出现两份。当前只包含用户 Provider 凭据的加解密。

## 目录结构

- `src/credential-crypto.ts`：AES-256-GCM 加解密实现，以及主密钥缺失或不合法时的 `CredentialCryptoConfigurationError`。
- `src/index.ts`：包出口，转出上面的函数、错误类型与 `EncryptedCredential` 类型。
- `tests/credential-crypto.test.ts`：单元测试，含用 Python 侧实现生成的跨语言密文向量。

## 消费方式与解析约束

本包以 **TypeScript 源码**形式被消费（`exports` 直接指向 `src/index.ts`），由消费方打包：

- Web 通过 `next.config.ts` 的 `transpilePackages` 交给 Turbopack 编译。
- Agent Worker 通过 esbuild 打包进 `dist/worker.js` 与 `dist/dispatcher.js`。

因此包内相对导入**不带扩展名**，且包与消费方的 tsconfig 都使用 `moduleResolution: "bundler"`。这不是风格偏好：Turbopack 不会把 `./credential-crypto.js` 映射到 `.ts`，一旦写成 NodeNext 风格，`tsc --noEmit`、Vitest 与 esbuild 都能通过，只有 `next build` 会失败。

后果是源码不能被 Node 直接以 ESM 方式加载（Node 要求显式扩展名）。如果将来需要让非打包环境（例如原生 Node 脚本或另一个包）直接引用本包，必须补一个真实的构建产物与 `exports` 条件导出，而不是改回 `.js` 后缀。

## 密钥来源

`CREDENTIAL_ENCRYPTION_KEY` 与 `CREDENTIAL_ENCRYPTION_KEY_VERSION` 由环境变量提供，Web 与实际调用生成模型的 Worker 必须使用同一份值；Web 保存密文、IV、认证标签与密钥版本到 `user_model_connections`，列表与详情接口不返回密钥。丢失主密钥将无法解密既有用户连接。

## 常用命令

```powershell
pnpm --filter @learncraft/security-primitives typecheck
pnpm --filter @learncraft/security-primitives test
```
