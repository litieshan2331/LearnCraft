# Session 适配目录

这里实现 Route Handler 的 Cookie 读取、写入和清除；认证规则与 Session 生命周期仍归属 Identity 上下文。Cookie 名称固定为 `lc_session`，使用 `HttpOnly`、`SameSite=Lax`；本地 HTTP 是否带 `Secure` 由 `SESSION_COOKIE_SECURE` 显式配置，生产 HTTPS 必须为 `true`。
