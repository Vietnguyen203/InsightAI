# Web edge image: the built SPA served by Caddy, which also reverse-proxies /api and /health to
# the API (same origin, automatic HTTPS). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t insightai-web .

ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @insightai/web... --filter @insightai/contracts
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @insightai/contracts build && pnpm --filter @insightai/web build

FROM caddy:2.10.2-alpine AS runtime
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
EXPOSE 80 443
