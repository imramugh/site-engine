FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages/contract ./packages/contract
COPY packages/engine ./packages/engine
COPY packages/checks ./packages/checks
COPY packages/theme-starter ./packages/theme-starter
COPY apps/site ./apps/site
ARG SITE_PUBLIC_ORIGIN=https://example.invalid
ARG SITE_CRAWLER_MODE=public
RUN pnpm install --frozen-lockfile --filter @site-engine/site... && pnpm --filter @site-engine/contract build && pnpm --filter @site-engine/engine build && pnpm --filter @site-engine/checks build && pnpm --filter @site-engine/theme-starter build && pnpm --filter @site-engine/site build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY --from=build /workspace/apps/site/dist /usr/share/nginx/html
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1
