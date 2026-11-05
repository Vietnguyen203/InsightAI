# API and worker image (same image, different command). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t insightai-api .
# Targets: `runtime` (default; api/worker) and `migrate` (one-shot: roles + migrations).

ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /repo

FROM base AS build
# Manifests first: dependency layers are cached until a lockfile or manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @insightai/api... --filter @insightai/contracts
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @insightai/contracts build \
 && pnpm --filter @insightai/api build \
 && pnpm --filter @insightai/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist

# One-shot job: creates/updates PostgreSQL roles, then applies migrations (needs the dev CLI).
FROM build AS migrate
WORKDIR /repo/apps/api
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "node scripts/bootstrap-db.mjs && pnpm exec prisma migrate deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
