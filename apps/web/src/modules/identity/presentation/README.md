# Identity 前端表现层

本目录承载 Identity 限界上下文的浏览器代码。

- `components/`：登录、注册、登出和 Session 守卫等 UI 组件。
- `api/`：只调用同域 BFF 的 `/api/v1/auth/*` 接口；不直接访问数据库、Redis 或领域 repository。

页面路由位于 `app/(auth)` 和 `app/(learn)`，只负责组合本目录的组件。注册成功后不创建 Cookie，只有登录接口会创建 Session。
