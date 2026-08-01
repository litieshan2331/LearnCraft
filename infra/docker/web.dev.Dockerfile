# LearnCraft Web 开发容器镜像。
# 功能：安装 pnpm 工作区依赖；源码由 compose.dev.yaml 以绑定挂载提供，容器使用 next dev 启动热更新服务。

FROM node:24.18.0-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NODE_ENV=development

RUN corepack enable

WORKDIR /app

# 仅复制依赖描述文件，使源码改动不会使依赖安装层失效。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
