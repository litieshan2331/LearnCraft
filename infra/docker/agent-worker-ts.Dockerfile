# LearnCraft Agent Worker（TypeScript）生产容器镜像。
# 阶段：
# - dependencies：安装 pnpm 工作区依赖（仅 Agent Worker 及其工作区依赖）。
# - build：用 esbuild 打包出可运行的 dist（worker 与 dispatcher 两个入口）。
# - runtime：以非 root 用户运行，入口由 compose 的 command 指定。

FROM node:24.18.0-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

# 在基础层安装并激活锁定版本，运行阶段无需由 Corepack 联网下载 pnpm。
RUN corepack enable && corepack install --global pnpm@11.15.0

WORKDIR /app

FROM base AS dependencies

# 工作区共 5 个工程：即使只安装其中一个，也需要完整的工作区描述文件才能通过 frozen-lockfile 校验。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/agent-worker-ts/package.json apps/agent-worker-ts/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/security-primitives/package.json packages/security-primitives/package.json

RUN pnpm install --frozen-lockfile --filter @learncraft/agent-worker-ts...

FROM dependencies AS build

COPY apps/agent-worker-ts apps/agent-worker-ts
COPY packages/security-primitives packages/security-primitives

RUN pnpm --filter @learncraft/agent-worker-ts build

FROM base AS runtime

ENV NODE_ENV=production

RUN groupadd --gid 1001 learncraft \
    && useradd --uid 1001 --gid learncraft --create-home learncraft

COPY --from=build --chown=learncraft:learncraft /app /app

WORKDIR /app/apps/agent-worker-ts

USER learncraft

# 默认入口为 BullMQ Worker；dispatcher 服务在 compose 中覆盖 command。
CMD ["node", "dist/worker.js"]
