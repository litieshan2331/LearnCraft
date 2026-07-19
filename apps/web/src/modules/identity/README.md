# Identity 限界上下文

本上下文负责邮箱密码账号、Argon2id 密码哈希、不透明 Session 与当前用户身份。它不负责学习画像、目标或路线。

`domain` 放身份规则与 repository interface；`application` 放注册、登录、登出等用例；`infrastructure` 放 Drizzle 与 Session 具体实现；`interfaces` 放 Zod 输入校验和 HTTP presenter。
