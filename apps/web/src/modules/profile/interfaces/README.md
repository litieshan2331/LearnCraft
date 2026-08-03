# Profile 接口层

本层包含：

- `profile-schemas.ts`：画像、目标、路由参数与幂等键的 Zod 校验；
- `profile-presenter.ts`：领域快照到 snake_case API 响应的映射；
- `profile-http.ts`：Session 鉴权、受限续期和业务错误映射。

对应浏览器 API 为 `GET/PUT /api/v1/learner-profile`、`POST /api/v1/learning-goals` 与 `GET /api/v1/learning-goals/{goal_id}`。
