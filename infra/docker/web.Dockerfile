# LearnCraft Web 容器镜像。
# 阶段：
# - dependencies：安装 pnpm 工作区依赖。
# - build：构建 Next.js Web 应用。
# - runtime：以非 root 用户启动 Web 服务。

FROM node:24.18.0-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

# 在基础层安装并激活锁定版本，运行阶段无需由 Corepack 联网下载 pnpm。
RUN corepack enable && corepack install --global pnpm@11.15.0

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY apps/web apps/web
COPY packages/contracts packages/contracts

RUN pnpm --filter @learncraft/web build

FROM base AS runtime

ENV NODE_ENV=production

RUN groupadd --gid 1001 learncraft \
    && useradd --uid 1001 --gid learncraft --create-home learncraft

COPY --from=build --chown=learncraft:learncraft /app /app

WORKDIR /app/apps/web

USER learncraft

EXPOSE 3000

CMD ["pnpm", "start", "--hostname", "0.0.0.0", "--port", "3000"]
