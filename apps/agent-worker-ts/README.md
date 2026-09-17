# LearnCraft Agent Worker（TypeScript）

本目录是 Agent 侧 TypeScript 实现的**并行工程**，用于逐步替换 `apps/agent-worker` 的 Python 实现。
迁移方案、阶段划分与验收标准见 [docs/09-全栈TypeScript迁移方案.md](../../docs/09-全栈TypeScript迁移方案.md)。

## 目录说明约定

每个目录下都有一份 `README.md`，说明该目录的职责与其下每个文件的作用（对应 Python 包 `__init__.py`
的说明功能）；新增目录时必须一并添加。

## 当前范围

| 文件 | 职责 |
| --- | --- |
| `src/infrastructure/llm/public-address.ts` | 公网地址判定（自建拒绝表，等价于 Python 的 `ipaddress.is_global`），显式解包 IPv4-mapped IPv6 与 NAT64 |
| `src/infrastructure/llm/egress-policy.ts` | Base URL 策略：仅 https/443、禁止 userinfo 与相对路径段、禁止 IP 字面量与本地域名、DNS 全结果校验并钉死首个地址 |
| `src/infrastructure/llm/safe-egress-client.ts` | 受控出网客户端：固定 IP 连接 + 原域名 SNI/证书校验 + 显式 Host 头、禁止重定向、按解压后字节限制响应体、SSE 结构校验、出网前审计 fail-closed |
| `src/infrastructure/llm/credential-decryptor.ts` | 凭据信封解密，错误码与 Python 的 `ModelCredentialDecryptor` 一致；加密实现来自共享包 |
| `src/infrastructure/database/agent-run-repository.ts` | AgentRun 生命周期 Repository：`FOR UPDATE` 行锁、终态短路幂等、事件序号、retry_count 单调、错误字段截断 |

共享包 `packages/security-primitives` 提供 Web 与 Worker 共用的 AES-256-GCM 实现；Web 侧
`apps/web/src/lib/security/credential-crypto.ts` 已改为转出该包，对外行为不变。

与 Python 现状的对应关系、以及 Node 侧的关键差异（不能用 `fetch`、`lookup` 必须兼容 `all:true`、
WHATWG URL 会归一化 `..` 与整数主机名）记录在 `docs/09` 第 8.1 节。

## 尚未实现

- BullMQ 队列与 Dispatcher、Web 内部 API ACL 客户端、Tavily MCP。
- 四个业务工作流的 LangGraph.js 图。
- 进程入口（dispatcher/worker/health）、Compose 服务与 CI。

在完成 `docs/09` 阶段 2 与阶段 3 的全部验收项之前，**不得**给本工程配置真实用户 BYOK 密钥。

## 命令

```powershell
pnpm --filter @learncraft/agent-worker-ts typecheck
pnpm --filter @learncraft/agent-worker-ts test
```

### 真实数据库只读冒烟（默认跳过，只执行 SELECT）

```powershell
$env:AGENT_TS_TEST_DATABASE_URL = '<postgres 连接串>'
$env:CREDENTIAL_ENCRYPTION_KEY = '<Base64 的 32 字节主密钥>'
$env:CREDENTIAL_ENCRYPTION_KEY_VERSION = '<密钥版本>'
pnpm --filter @learncraft/agent-worker-ts exec vitest run tests/integration/live-readonly.test.ts
```

该用例会核对 `agent` schema 的列是否覆盖 Repository 使用的字段，并解密一条真实模型连接凭据
（只输出长度与前缀，不输出明文），不会写入任何数据。

### 真实端到端冒烟（会产生真实费用并写入真实数据）

`tests/integration/live-e2e.test.ts` 执行完整链路：写入夹具（goal + agent_run）
→ `beginExecution` 领取并加行锁 → 解密真实凭据 → 受控出网调用真实 Provider（SSE）
→ `markSucceeded` 回写 → 校验状态与事件序列 → 验证重复投递幂等。

必须同时设置三项才会运行，否则整个文件跳过：

```powershell
$env:AGENT_TS_LIVE_E2E = '1'          # 显式确认：允许真实模型调用与真实写入
$env:AGENT_TS_TEST_DATABASE_URL = '<postgres 连接串>'
$env:CREDENTIAL_ENCRYPTION_KEY = '<Base64 的 32 字节主密钥>'
$env:CREDENTIAL_ENCRYPTION_KEY_VERSION = '<密钥版本>'
pnpm --filter @learncraft/agent-worker-ts exec vitest run tests/integration/live-e2e.test.ts
```

用例**不会**自行删除夹具（便于人工核对运行记录），执行结束会打印三条清理 SQL。
该用例只应在本机开发库运行，不得指向生产库。

`tests/fixtures/test-only-*.pem` 是仅用于回环 TLS 测试的自签证书，不是任何环境的真实凭据。
