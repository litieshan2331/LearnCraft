# 共享 UI

本目录只放至少被两个不同业务上下文复用、且不包含业务规则的界面组件。当前 `brand.tsx` 被公共首页、认证布局和学习区布局共享。

`primitives/` 存放由 shadcn/ui 生成并纳入仓库维护的通用基础组件，例如 `Button`、`Input`、`Card`。组件源码可按 LearnCraft 的设计令牌调整，但不能包含登录、学习路线或题目等业务规则。

业务表单、学习卡片、路线节点等组件应优先放入对应 `modules/<业务>/presentation/components/`，不要提前堆放到这里。
