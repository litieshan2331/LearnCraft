# Identity 限界上下文

本上下文负责邮箱密码账号、Argon2id 密码哈希、不透明 Session、Redis 认证限流与当前用户身份。它不负责学习画像、目标或路线。

`domain` 放身份规则、Session 时长策略与 repository interface；`application` 放注册、登录、登出等用例；`infrastructure` 放 Drizzle、Argon2id 与 Redis 具体实现；`interfaces` 放 Zod 输入校验、Origin 校验和 HTTP presenter。

注册只创建用户与 Argon2id 密码哈希，不会创建 Session 或设置 Cookie；只有密码登录成功后才会创建数据库 Session 并下发 Cookie。

Session 闲置 3 天失效，从创建起最长 15 天。仅在剩余不足 24 小时且距上次续期超过 12 小时时续期，避免每次读取都写数据库。
